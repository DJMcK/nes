/*
    hapi-nes WebSocket Client
    Copyright (c) 2015, Eran Hammer <eran@hammer.io> and other contributors
    BSD Licensed
*/


(function (root, factory) {

    // Export if used as a module

    // $lab:coverage:off$
    if (typeof exports === 'object' && typeof module === 'object') {
        module.exports = factory();
    }
    else if (typeof define === 'function' && define.amd) {
        define(factory);
    }
    else if (typeof exports === 'object') {
        exports.nes = factory();
    }
    else {
        root.nes = factory();
    }
    // $lab:coverage:on$
})(this, function () {

    var ignore = function () { };

    // $lab:coverage:off$
    var WS = (typeof WebSocket === 'undefined' ? require('ws') : WebSocket);        // Using require vs proper UMD binding as we assume WebSocket is available through native bindings in all environments
    // $lab:coverage:on$

    var Client = function (url, options) {

        // Configuration

        this._url = url;
        this._settings = options;                   // node.js only

        // State

        this._ws = null;
        this._reconnection = null;
        this._ids = 0;                              // Id counter
        this._requests = {};                        // id -> callback

        // Events

        this.onError = console.error;               // General error callback (only when an error cannot be associated with a request)
        this.onConnect = ignore;                    // Called whenever a connection is established
        this.onBroadcast = ignore;
    };

    Client.prototype.connect = function (options, callback) {

        if (typeof options === 'function') {
            callback = arguments[0];
            options = {};
        }

        if (options.reconnect !== false) {                  // Defaults to true
            this._reconnection = {                          // Options: reconnect, delay, maxDelay
                wait: 0,
                delay: options.delay || 1000,               // 1 second
                maxDelay: options.maxDelay || 5000,         // 5 seconds
                auth: options.auth
            };
        }
        else {
            this._reconnection = null;
        }

        this._connect(options.auth, callback);
    };

    Client.prototype._connect = function (auth, callback) {

        var self = this;

        var ws = new WS(this._url, this._settings);         // Settings used by node.js only
        this._ws = ws;

        var sentCallback = false;
        ws.onopen = function () {

            if (!sentCallback) {
                sentCallback = true;
                self.onConnect();
                if (!auth) {
                    return callback();
                }

                self.authenticate(auth, callback);
            }
        };

        ws.onerror = function (err) {

            if (!sentCallback) {
                sentCallback = true;
                return callback(err);
            }

            return self.onError(err);
        };

        ws.onclose = function () {

            return self._onClose();
        };

        ws.onmessage = function (message) {

            return self._onMessage(message);
        };
    };

    Client.prototype.disconnect = function () {

        this._reconnection = null;

        if (!this._ws) {
            return;
        }

        if (this._ws.readyState === WS.OPEN ||
            this._ws.readyState === WS.CONNECTING) {

            this._ws.close();
        }
    };

    Client.prototype._onClose = function () {

        this._ws = null;

        // Flush pending requests

        var error = new Error('Disconnected');

        var ids = Object.keys(this._requests);
        for (var i = 0, il = ids.length; i < il; ++i) {
            var id = ids[i];
            var callback = this._requests[id];
            delete this._requests[id];
            callback(error);
        }

        this._reconnect();
    };

    Client.prototype._reconnect = function () {

        var self = this;

        // Reconnect

        if (this._reconnection) {
            this._reconnection.wait += this._reconnection.delay;

            var timeout = Math.min(this._reconnection.wait, this._reconnection.maxDelay);
            setTimeout(function () {

                self._connect(self._reconnection.auth, function (err) {

                    if (err) {
                        self.onError(err);
                        return self._reconnect();
                    }
                });
            }, timeout);
        }
    };

    Client.prototype.request = function (options, callback) {

        if (typeof options === 'string') {
            options = {
                method: 'GET',
                path: options
            };
        }

        var self = this;

        var request = {
            id: 0,
            nes: 'request',
            method: options.method,
            path: options.path,
            headers: options.headers,
            payload: options.payload
        };

        return this._send(request, function (err, update) {

            if (err) {
                return callback(err);
            }

            if (update.nes !== 'response') {
                self.onError(new Error('Received unexpected response type: ' + update.nes));
            }
            else {
                var error = (update.statusCode >= 400 && update.statusCode <= 599 ? new Error(update.payload.message) : null);
                callback(error, update.payload, update.statusCode, update.headers);
            }
        });
    };

    Client.prototype._send = function (request, callback) {

        var self = this;

        if (!this._ws ||
            this._ws.readyState !== WS.OPEN) {

            return callback(new Error('Disconnected'));
        }

        request.id = ++this._ids;

        stringify(request, function (err, encoded) {

            if (err) {
                return callback(err);
            }

            self._requests[request.id] = callback;

            try {
                self._ws.send(encoded);
            }
            catch (err) {
                delete self._requests[request.id];
                return callback(err);
            }
        });
    };

    Client.prototype.authenticate = function (token, callback) {

        var self = this;

        var request = {
            id: 0,
            nes: 'auth',
            token: token
        };

        return this._send(request, function (err, update) {

            if (err) {
                return callback(err);
            }

            if (update.nes !== 'auth') {
                self.onError(new Error('Received unexpected response type: ' + update.nes));
            }
            else {
                callback(update.error ? new Error(update.error) : null);
            }
        });
    };

    Client.prototype._onMessage = function (message) {

        var self = this;

        parse(message.data, function (err, update) {

            if (err) {
                return self.onError(err);
            }

            if (update.nes === 'broadcast') {
                return self.onBroadcast(update.message);
            }

            // Lookup callback

            var callback = self._requests[update.id];
            delete self._requests[update.id];
            if (!callback) {
                self.onError(new Error('Received response for missing request'));
            }
            else {
                callback(null, update);
            }
        });
    };

    var parse = function (message, next) {

        var obj = null;
        var error = null;

        try {
            obj = JSON.parse(message);
        }
        catch (err) {
            error = err;
        }

        return next(error, obj);
    };

    var stringify = function (message, next) {

        var string = null;
        var error = null;

        try {
            string = JSON.stringify(message);
        }
        catch (err) {
            error = err;
        }

        return next(error, string);
    };


    // Declare namespace

    var nes = {
        Client: Client
    };

    return nes;
});
