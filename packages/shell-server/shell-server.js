var assert = require("assert");
var path = require("path");
var stream = require("stream");
var fs = require("fs");
var net = require("net");
var vm = require("vm");
var _ = require("underscore");
import { default as moduleRepl } from "repl";

var INFO_FILE_MODE = parseInt("600", 8); // Only the owner can read or write.
var EXITING_MESSAGE = "Shell exiting...";

// Invoked by the server process to listen for incoming connections from
// shell clients. Each connection gets its own REPL instance.
export function listen(shellDir) {
  function callback() {
    new Server(shellDir).listen();
  }

  // If the server is still in the very early stages of starting up,
  // Meteor.startup may not available yet.
  if (typeof Meteor === "object") {
    Meteor.startup(callback);
  } else if (typeof __meteor_bootstrap__ === "object") {
    var hooks = __meteor_bootstrap__.startupHooks;
    if (hooks) {
      hooks.push(callback);
    } else {
      // As a fallback, just call the callback asynchronously.
      setImmediate(callback);
    }
  }
}

// Disabling the shell causes all attached clients to disconnect and exit.
export function disable(shellDir) {
  try {
    // Replace info.json with a file that says the shell server is
    // disabled, so that any connected shell clients will fail to
    // reconnect after the server process closes their sockets.
    fs.writeFileSync(
      getInfoFile(shellDir),
      JSON.stringify({
        status: "disabled",
        reason: "Shell server has shut down."
      }) + "\n",
      { mode: INFO_FILE_MODE }
    );
  } catch (ignored) {}
}

// Shell commands need to be executed in a Fiber in case they call into
// code that yields. Using a Promise is an even better idea, since it runs
// its callbacks in Fibers drawn from a pool, so the Fibers are recycled.
const evalCommandPromise = Promise.resolve();

class Server {
  constructor(shellDir) {
    var self = this;
    assert.ok(self instanceof Server);

    self.shellDir = shellDir;
    self.key = Math.random().toString(36).slice(2);

    self.server = net.createServer(function(socket) {
      self.onConnection(socket);
    }).on("error", function(err) {
      console.error(err.stack);
    });
  }

  listen() {
    var self = this;
    var infoFile = getInfoFile(self.shellDir);

    fs.unlink(infoFile, function() {
      self.server.listen(0, "127.0.0.1", function() {
        fs.writeFileSync(infoFile, JSON.stringify({
          status: "enabled",
          port: self.server.address().port,
          key: self.key
        }) + "\n", {
          mode: INFO_FILE_MODE
        });
      });
    });
  }

  onConnection(socket) {
    var self = this;

    // Make sure this function doesn't try to write anything to the socket
    // after it has been closed.
    socket.on("close", function() {
      socket = null;
    });

    // If communication is not established within 1000ms of the first
    // connection, forcibly close the socket.
    var timeout = setTimeout(function() {
      if (socket) {
        socket.removeAllListeners("data");
        socket.end(EXITING_MESSAGE + "\n");
      }
    }, 1000);

    // Let connecting clients configure certain REPL options by sending a
    // JSON object over the socket. For example, only the client knows
    // whether it's running a TTY or an Emacs subshell or some other kind of
    // terminal, so the client must decide the value of options.terminal.
    readJSONFromStream(socket, function (error, options, replInputSocket) {
      clearTimeout(timeout);

      if (error) {
        socket = null;
        console.error(error.stack);
        return;
      }

      if (options.key !== self.key) {
        if (socket) {
          socket.end(EXITING_MESSAGE + "\n");
        }
        return;
      }
      delete options.key;

      // Set the columns to what is being requested by the client.
      if (options.columns && socket) {
        socket.columns = options.columns;
      }
      delete options.columns;

      // Immutable options.
      _.extend(options, {
        input: replInputSocket,
        useGlobal: false,
        output: socket
      });

      // Overridable options.
      _.defaults(options, {
        prompt: "> ",
        terminal: true,
        useColors: true,
        ignoreUndefined: true,
      });

      // The prompt during an evaluateAndExit must be blank to ensure
      // that the prompt doesn't inadvertently get parsed as part of
      // the JSON communication channel.
      if (options.evaluateAndExit) {
        options.prompt = "";
      }

      // Start the REPL.
      self.startREPL(options);

      if (options.evaluateAndExit) {
        self._wrappedDefaultEval.call(
          Object.create(null),
          options.evaluateAndExit.command,
          global,
          options.evaluateAndExit.filename || "<meteor shell>",
          function (error, result) {
            if (socket) {
              var message = error ? {
                error: error + "",
                code: 1
              } : {
                result: result
              };

              // Sending back a JSON payload allows the client to
              // distinguish between errors and successful results.
              socket.end(JSON.stringify(message) + "\n");
            }
          }
        );
        return;
      }
      delete options.evaluateAndExit;

      self.enableInteractiveMode(options);
    });
  }

  startREPL(options) {
    // Make sure this function doesn't try to write anything to the output
    // stream after it has been closed.
    options.output.on("close", function() {
      options.output = null;
    });

    const repl = this.repl = moduleRepl.start(options);

    // This is technique of setting `repl.context` is similar to how the
    // `useGlobal` option would work during a normal `repl.start()` and
    // allows shell access (and tab completion!) to Meteor globals (i.e.
    // Underscore _, Meteor, etc.). By using this technique, which changes
    // the context after startup, we avoid stomping on the special `_`
    // variable (in `repl` this equals the value of the last command) from
    // being overridden in the client/server socket-handshaking.  Furthermore,
    // by setting `useGlobal` back to true, we allow the default eval function
    // to use the desired `runInThisContext` method (https://git.io/vbvAB).
    repl.context = global;
    repl.useGlobal = true;

    // In order to avoid duplicating code here, specifically the complexities
    // of catching so-called "Recoverable Errors" (https://git.io/vbvbl),
    // we will wrap the default eval, run it in a Fiber (via a Promise), and
    // give it the opportunity to decide if the user is mid-code-block.
    const defaultEval = repl.eval;

    function wrappedDefaultEval(code, context, file, callback) {
      if (Package.ecmascript) {
        try {
          code = Package.ecmascript.ECMAScript.compileForShell(code);
        } catch (err) {
          // Any Babel error here might be just fine since it's
          // possible the code was incomplete (multi-line code on the REPL).
          // The defaultEval below will use its own functionality to determine
          // if this error is "recoverable".
        }
      }

      evalCommandPromise
        .then(() => defaultEval(code, context, file, callback))
        .catch(callback);
    }

    // Have the REPL use the newly wrapped function instead and store the
    // _wrappedDefaultEval so that evalulateAndExit calls can use it directly.
    repl.eval = this._wrappedDefaultEval = wrappedDefaultEval;
  }

  enableInteractiveMode(options) {
    // History persists across shell sessions!
    this.initializeHistory();

    const repl = this.repl;

    // Implement an alternate means of fetching the return value,
    // via `__` (double underscore) as originally implemented in:
    // https://github.com/meteor/meteor/commit/2443d832265c7d1c
    Object.defineProperty(repl.context, "__", {
      get: () => repl.last,
      set: (val) => {
        repl.last = val;
      },

      // Allow this property to be (re)defined more than once (e.g. each
      // time the server restarts).
      configurable: true
    });

    setRequireAndModule(repl.context);

    repl.context.repl = repl;

    // Some improvements to the existing help messages.
    function addHelp(cmd, helpText) {
      var info = repl.commands[cmd] || repl.commands["." + cmd];
      if (info) {
        info.help = helpText;
      }
    }
    addHelp("break", "Terminate current command input and display new prompt");
    addHelp("exit", "Disconnect from server and leave shell");
    addHelp("help", "Show this help information");

    // When the REPL exits, signal the attached client to exit by sending it
    // the special EXITING_MESSAGE.
    repl.on("exit", function() {
      if (options.output) {
        options.output.write(EXITING_MESSAGE + "\n");
        options.output.end();
      }
    });

    // When the server process exits, end the output stream but do not
    // signal the attached client to exit.
    process.on("exit", function() {
      if (options.output) {
        options.output.end();
      }
    });

    // This Meteor-specific shell command rebuilds the application as if a
    // change was made to server code.
    repl.defineCommand("reload", {
      help: "Restart the server and the shell",
      action: function() {
        process.exit(0);
      }
    });
  }

  // This function allows a persistent history of shell commands to be saved
  // to and loaded from .meteor/local/shell-history.
  initializeHistory() {
    var self = this;
    var rli = self.repl.rli;
    var historyFile = getHistoryFile(self.shellDir);
    var historyFd = fs.openSync(historyFile, "a+");
    var historyLines = fs.readFileSync(historyFile, "utf8").split("\n");
    var seenLines = Object.create(null);

    if (! rli.history) {
      rli.history = [];
      rli.historyIndex = -1;
    }

    while (rli.history && historyLines.length > 0) {
      var line = historyLines.pop();
      if (line && /\S/.test(line) && ! seenLines[line]) {
        rli.history.push(line);
        seenLines[line] = true;
      }
    }

    rli.addListener("line", function(line) {
      if (historyFd >= 0 && /\S/.test(line)) {
        fs.writeSync(historyFd, line + "\n");
      }
    });

    self.repl.on("exit", function() {
      fs.closeSync(historyFd);
      historyFd = -1;
    });
  }
}

function readJSONFromStream(inputStream, callback) {
  var outputStream = new stream.PassThrough;
  var dataSoFar = "";

  function onData(buffer) {
    var lines = buffer.toString("utf8").split("\n");

    while (lines.length > 0) {
      dataSoFar += lines.shift();

      try {
        var json = JSON.parse(dataSoFar);
      } catch (error) {
        if (error instanceof SyntaxError) {
          continue;
        }

        return finish(error);
      }

      if (lines.length > 0) {
        outputStream.write(lines.join("\n"));
      }

      inputStream.pipe(outputStream);

      return finish(null, json);
    }
  }

  function onClose() {
    finish(new Error("stream unexpectedly closed"));
  }

  var finished = false;
  function finish(error, json) {
    if (! finished) {
      finished = true;
      inputStream.removeListener("data", onData);
      inputStream.removeListener("error", finish);
      inputStream.removeListener("close", onClose);
      callback(error, json, outputStream);
    }
  }

  inputStream.on("data", onData);
  inputStream.on("error", finish);
  inputStream.on("close", onClose);
}

function getInfoFile(shellDir) {
  return path.join(shellDir, "info.json");
}

function getHistoryFile(shellDir) {
  return path.join(shellDir, "history");
}


function setRequireAndModule(context) {
  if (Package.modules) {
    // Use the same `require` function and `module` object visible to the
    // application.
    var toBeInstalled = {};
    var shellModuleName = "meteor-shell-" +
      Math.random().toString(36).slice(2) + ".js";

    toBeInstalled[shellModuleName] = function (require, exports, module) {
      context.module = module;
      context.require = require;

      // Tab completion sometimes uses require.extensions, but only for
      // the keys.
      require.extensions = {
        ".js": true,
        ".json": true,
        ".node": true,
      };
    };

    // This populates repl.context.{module,require} by evaluating the
    // module defined above.
    Package.modules.meteorInstall(toBeInstalled)("./" + shellModuleName);
  }
}
