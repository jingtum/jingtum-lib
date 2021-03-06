'use strict';
var Event = require('events').EventEmitter;
var util = require('util');
var LRU = require('lru-cache');
var sha1 = require('sha1');
var utf8 = require('utf8');

var Server = require('./server');
var Request = require('./request');
var Account = require('./account');
var Transaction = require('./transaction');
var OrderBook = require('./orderbook');
var utils = require('./utils');
var _ = require('lodash');
const currency = require('./config').currency;
const fee = require('./config').fee;
var bignumber = require('bignumber.js');
var Tum3 = require('tum3');
var AbiCoder = require('tum3-eth-abi').AbiCoder;
var KeyPair = require('jingtum-base-lib').KeyPair;

var LEDGER_OPTIONS = ['closed', 'header', 'current'];

/**
 * main handler for backend system
 * one remote object one server, not many
 * options onfiguration Parameters:
 * {
 *   local_sign: false, // default sign tx in jingtumd
 *   server: 'wss://s.jingtum.com:5020', // only support one server
 * }
 * @param options
 * @constructor
 */
function Remote(options) {
    Event.call(this);

    var self = this;
    var _opts = options || {};

    self._local_sign = !!_opts.local_sign;

    if (typeof _opts.server !== 'string') {
        self.type = new TypeError('server config not supplied');
        return self;
    }
    self._url = _opts.server;
    self._server = new Server(self, self._url);
    self._status = {ledger_index: 0};
    self._requests = {};

    self._cache = LRU({max: 100, maxAge: 1000 * 60 * 5}); // 100 size, 5 min
    self._paths = LRU({max: 100, maxAge: 1000 * 60 * 5}); // 2100 size, 5 min

    self.on('newListener', function(type, listener) {
        if (!self._server.isConnected()) return;
        if (type === 'removeListener') return;
        if (type === 'transactions') {
            self.subscribe('transactions').submit();
        }
        if (type === 'ledger_closed') {
            self.subscribe('ledger').submit();
        }
    });
    self.on('removeListener', function(type) {
        if (!self._server.isConnected()) return;
        if (type === 'transactions') {
            self.unsubscribe('transactions').submit();
        }
        if (type === 'ledger_closed') {
            self.unsubscribe('ledger').submit();
        }
    });
}
util.inherits(Remote, Event);

/**
 * connect first on every case
 * callback(error, result)
 * @param callback
 * @returns {*}
 */
Remote.prototype.connect = function(callback) {
    if (!this._server) return callback('server not ready');
    this._server.connect(callback);
};

/**
 * disconnect manual, no reconnect
 */
Remote.prototype.disconnect = function() {
    if (!this._server) return;
    this._server.disconnect();
};

/**
 * check is remote is connected to jingtumd
 */
Remote.prototype.isConnected = function () {
    return this._server.isConnected();
};

/**
 * handle message from backend, and dispatch
 * @param data
 * @private
 */
Remote.prototype._handleMessage = function(data) {
    var self = this;
    try {
        data = JSON.parse(data);
    } catch(e) {}
    if (typeof data !== 'object') return;

    switch(data.type) {
        case 'ledgerClosed':
            self._handleLedgerClosed(data);
            break;
        case 'serverStatus':
            self._handleServerStatus(data);
            break;
        case 'response':
            self._handleResponse(data);
            break;
        case 'transaction':
            self._handleTransaction(data);
            break;
        case 'path_find':
            self._handlePathFind(data);
            break;
    }
};

/**
 * update server ledger status
 * TODO
 * supply data to outside include ledger, reserve and fee
 * @param data
 * @private
 */
Remote.prototype._handleLedgerClosed = function(data) {
    var self = this;
    if (data.ledger_index > self._status.ledger_index) {
        self._status.ledger_index = data.ledger_index;
        self._status.ledger_time = data.ledger_time;
        self._status.reserve_base = data.reserve_base;
        self._status.reserve_inc = data.reserve_inc;
        self._status.fee_base = data.fee_base;
        self._status.fee_ref = data.fee_ref;
        self.emit('ledger_closed', data);
    }
};

/**
 * TODO
 * supply data to outside about server status
 * @param data
 * @private
 */
Remote.prototype._handleServerStatus = function(data) {
    // TODO check data format
    this._updateServerStatus(data);
    this.emit('server_status', data);
};

/**
 * update remote state and server state
 * @param data
 * @private
 */
Remote.prototype._updateServerStatus = function(data) {
    this._status.load_base = data.load_base;
    this._status.load_factor = data.load_factor;
    if (data.pubkey_node) {
         this._status.pubkey_node = data.pubkey_node;
    }
    this._status.server_status = data.server_status;
    var online = ~Server.onlineStates.indexOf(data.server_status);
    this._server._setState(online ? 'online' : 'offline');
};

function getTypes(abi, foo) {
    return abi.filter(function (json) {
        return json.name === foo
    }).map(function (json) {
        return json.outputs.map(function (input) {
            return input.type;
        });
    }).map(function (types) {
        return types;
    })[0] || '';
}
/**
 * handle response by every websocket request
 * @param data
 * @private
 */

Remote.prototype._handleResponse = function(data) {
    var req_id = data.id;
    if (typeof req_id !== 'number'
        || req_id < 0 || req_id > this._requests.length) {
        return;
    }
    var request = this._requests[req_id];
    // pass process it when null callback
    if(request.data && request.data.abi){
        data.abi = request.data.abi;
    }
    delete this._requests[req_id];
    delete data.id;

    // check if data contain server info
    if (data.result && data.status === 'success'
            && data.result.server_status) {
        this._updateServerStatus(data.result);
    }

    // return to callback
    if (data.status === 'success') {
        var result = request.filter(data.result);
        if(result.ContractState && result.tx_json.TransactionType === 'AlethContract' && result.tx_json.Method === 1){//调用合约时，如果是获取变量，则转换一下
            var method = utils.hexToString(result.tx_json.MethodSignature);
            result.func = method.substring(0, method.indexOf('('));//函数名
            result.func_parms = method.substring(method.indexOf('(') + 1, method.indexOf(')')).split(','); //函数参数
            if(result.func_parms.length === 1 && result.func_parms[0] === '')//没有参数，返回空数组
                result.func_parms = [];
            if(result.engine_result === 'tesSUCCESS'){
                var abi = new AbiCoder();
                var types = getTypes(data.abi, result.func);
                result.ContractState = abi.decodeParameters(types, result.ContractState);
                types.forEach(function (type, i) {
                    if(type === 'address') {
                        var adr = result.ContractState[i].slice(2);
                        var buf = new Buffer(20);
                        buf.write(adr, 0, 'hex');
                        result.ContractState[i] = KeyPair.__encode(buf)
                    }
                });
            }

        }
        if(result.AlethLog){
            var logValue = [];
            var item = {address: '', data: {}};
            var logs = result.AlethLog;
            logs.forEach(function (log) {
                var _log = JSON.parse(log.item);
                var _adr = _log.address.slice(2);
                var buf = new Buffer(20);
                buf.write(_adr, 0, 'hex');
                item.address = KeyPair.__encode(buf);

                var abi = new AbiCoder();
                data.abi.filter(function (json) { return json.type === 'event' })
                    .map(function (json)
                    {
                        var types =  json.inputs.map(function (input) {
                            return input.type;
                        });
                        var foo = json.name + '(' + types.join(',')  + ')';
                        if(abi.encodeEventSignature(foo) === _log.topics[0]){
                            var data = abi.decodeLog(json.inputs, _log.data, _log.topics);
                            json.inputs.forEach(function (input, i) {
                                if(input.type === 'address'){
                                    var _adr = data[i].slice(2);
                                    var buf = new Buffer(20);
                                    buf.write(_adr, 0, 'hex');
                                    item.data[i] = KeyPair.__encode(buf);
                                }else {
                                    item.data[i] = data[i];
                                }
                            });
                        }
                    });

                logValue.push(item);
            });
            result.AlethLog = logValue;
        }
        if(result.TransactionType === 'SetBlackList' || result.TransactionType === 'RemoveBlackList'){ //该类型实际未收燃料费
            result.Fee = '0';
        }
        request && request.callback(null, result);
    } else if (data.status === 'error') {
        request && request.callback(data.error_message || data.error_exception || data.error);
    }
};

/**
 * handle transaction type response
 * TODO supply more friendly transaction data
 * @param data
 * @private
 */
Remote.prototype._handleTransaction = function(data) {
    var self = this;
    var tx = data.transaction.hash;
    if (self._cache.get(tx)) return;
    self._cache.set(tx, 1);
    this.emit('transactions', data);
};

/**
 * emit path find date to other
 * TODO supply more friendly data
 * @param data
 * @private
 */
Remote.prototype._handlePathFind = function(data) {
    this.emit('path_find', data);
};

/**
 * request to server and backend
 * @param command
 * @param data
 * @param filter
 * @param callback
 * @private
 */
Remote.prototype._submit = function(command, data, filter, callback) {
    if (!callback || typeof callback !== 'function') {
        callback = function() {};
    }
    var req_id = this._server.sendMessage(command, data);
    this._requests[req_id] = {
        command: command,
        data: data,
        filter: filter,
        callback: callback
    };
};

// ---------------------- info request --------------------
/**
 * request server info
 * return version, ledger, state and node id
 * no option is required
 * @returns {Request}
 */
Remote.prototype.requestServerInfo = function() {
    return new Request(this, 'server_info', function(data) {
        return {
            complete_ledgers: data.info.complete_ledgers,
            ledger: data.info.validated_ledger.hash,
            public_key: data.info.pubkey_node,
            state: data.info.server_state,
            peers: data.info.peers,
            version: 'skywelld-' + data.info.build_version
        };
    });
};

/**
 * request peers info
 * return version, ledger, state and node id
 * no option is required
 * @returns {Request}
 */
Remote.prototype.requestPeers = function() {
    return new Request(this, 'peers', function(data) {
        return data;
    });
};
/**
 * request last closed ledger index and hash
 * @returns {Request}
 */
Remote.prototype.requestLedgerClosed = function () {
    return new Request(this, 'ledger_closed', function(data) {
        return {
            // fee_base: data.fee_base,
            ledger_hash: data.ledger_hash,
            ledger_index: data.ledger_index,
            // reserve_base: data.reserve_base,
            // reserve_inc: data.reserve_base,
            // txn_count: data.txn_count,
            // validated: data.validated_ledgers
        };
    });
};

/**
 * get one ledger info
 * options parameters : {
 *   ledger_index: Number,
 *   ledger_hash: hash, string
 * }
 * if no options, return last closed ledger
 * @param options
 * @returns {Request}
 */
Remote.prototype.requestLedger = function(options) {
    // if (typeof options !== 'object') {
    //     return new Error('invalid options type');
    // }
    var cmd = 'ledger';
    var filter = true;
    var request = new Request(this, cmd, function(data) {
        var ledger = data.ledger || data.closed.ledger;
        if (!filter) {
            return ledger;
        }
        return {
            accepted: ledger.accepted,
            ledger_hash: ledger.hash,
            ledger_index: ledger.ledger_index,
            parent_hash: ledger.parent_hash,
            close_time: ledger.close_time_human,
            total_coins: ledger.total_coins
        };
    });
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    if (options.ledger_index && !/^[1-9]\d{0,9}$/.test(options.ledger_index)) {//支持0-10位数字查询
        request.message.ledger_index = new Error('invalid ledger_index');
        return request;
    }
    if(options.ledger_index){
        request.message.ledger_index = Number(options.ledger_index);
    }

    if (utils.isValidHash(options.ledger_hash)) {
        request.message.ledger_hash = options.ledger_hash;
    }
    if ('full' in options && typeof(options.full) === 'boolean') {
        request.message['full'] = options.full;
        filter = false;
    }
    if ('expand' in options && typeof(options.expand) === 'boolean') {
        request.message['expand'] = options.expand;
        filter = false;
    }
    if ('transactions' in options && typeof(options.transactions) === 'boolean') {
        request.message['transactions'] = options.transactions;
        filter = false;
    }
    if ('accounts' in options && typeof(options.accounts) === 'boolean') {
        request.message['accounts'] = options.accounts;
        filter = false;
    }

    return request;
};

/*
* get all accounts at some ledger_index
* */
Remote.prototype.requestAccounts = function(options) {
    var request = new Request(this, 'account_count');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    if (options.ledger_index && !/^[1-9]\d{0,9}$/.test(options.ledger_index)) {//支持0-10位数字查询
        request.message.ledger_index = new Error('invalid ledger_index');
        return request;
    }
    if (options.ledger_index) {
        request.message.ledger_index = Number(options.ledger_index);
    }
    if (utils.isValidHash(options.ledger_hash)) {
        request.message.ledger_hash = options.ledger_hash;
    }
    if (options.marker) {
        request.message.marker = options.marker;
    }

    return request;
};

/**
 * for tx command
 * @param options
 * options: {
 *   hash: tx hash, string  
 * }
 * @returns {Request}
 */
Remote.prototype.requestTx = function(options) {
    var request = new Request(this, 'tx');
    if (typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }

    var hash = options.hash;
    if (!utils.isValidHash(hash)) {
        request.message.hash = new Error('invalid tx hash');
        return request;
    }

    request.message.transaction = hash;
    return request;
};

function getRelationType(type) {
    switch (type) {
        case 'trustline':
            return 0;
            break;
        case 'authorize':
            return 1;
            break;
        case 'freeze':
            return 3;
            break;
        default:
            return null;
    }
}
/**
 * request account info, internal function
 * @param type
 * @param options
 * @returns {Request}
 * @private
 */
Remote.prototype.__requestAccount = function(type, options, request, filter) {
    // var request = new Request(this, type, filter);
    request._command = type;
    var account = options.account;
    var ledger = options.ledger;
    var peer = options.peer;
    var limit = options.limit;
    var marker = options.marker;
    // if (marker && (Number(ledger) <= 0 || !utils.isValidHash(ledger))) {
    //     throw new Error('marker needs a ledger_index or ledger_hash');
    // }
    request.message.relation_type = getRelationType(options.type);
    if (account) {
        if(!utils.isValidAddress(account)){
            request.message.account = new Error('invalid account');
            return request;
        }else {
            request.message.account = account;
        }
    }
    request.selectLedger(ledger);

    if (peer && utils.isValidAddress(peer)) {
        request.message.peer = peer;
    }
    if (Number(limit)) {
        limit = Number(limit);
        if (limit < 0) limit = 0;
        if (limit > 1e9) limit = 1e9;
        request.message.limit = limit;
    }
    if (marker) {
        request.message.marker = marker;
    }
    return request;
};

/**
 * account info
 * @param options, options:
 *    account(required): the query account
 *    ledger(option): specify ledger, ledger can be:
 *    ledger_index=xxx, ledger_hash=xxx, or ledger=closed|current|validated
 * @returns {Request}
 */
Remote.prototype.requestAccountInfo = function(options) {
    var request = new Request(this);

    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    return this.__requestAccount('account_info', options, request);
};

/**
 * account tums
 * return account supports currency, including
 *     send currency and receive currency
 * @param 
 *    account(required): the query account
 *    ledger(option): specify ledger, ledger can be:
 *    ledger_index=xxx, ledger_hash=xxx, or ledger=closed|current|validated 
 *    no limit
 * @returns {Request}
 */
Remote.prototype.requestAccountTums = function(options) {
    var request = new Request(this);

    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    return this.__requestAccount('account_currencies', options, request);
};

/**
 * account relations
 * @param options
 *    type: relation type
 *    account(required): the query account
 *    ledger(option): specify ledger, ledger can be:
 *    ledger_index=xxx, ledger_hash=xxx, or ledger=closed|current|validated  
 *    limit min is 200,
 *    marker for more relations
 * @returns {Request}
 */
Remote.prototype.requestAccountRelations = function(options) {
    var request = new Request(this);

    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    if (!~Transaction.RelationTypes.indexOf(options.type)) {
        request.message.relation_type = new Error('invalid realtion type');
        return request;
    }
    switch (options.type) {
        case 'trust':
            return this.__requestAccount('account_lines', options, request);
        case 'authorize':
        case 'freeze':
            return this.__requestAccount('account_relation', options, request);
    }
    request.message.msg = new Error('relation should not go here');
    return request;
};

/**
 * account offers
 * options parameters
 * @param options
 *    account(required): the query account
 *    ledger(option): specify ledger, ledger can be:
 *    ledger_index=xxx, ledger_hash=xxx, or ledger=closed|current|validated  
 *    limit min is 200, marker
 * @returns {Request}
 */
Remote.prototype.requestAccountOffers = function(options) {
    var request = new Request(this);

    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    return this.__requestAccount('account_offers', options, request);
};

/**
 * account tx
 * options parameters
 *    account(required): the query account
 *    ledger(option): specify ledger, ledger can be:
 *    ledger_index=xxx, ledger_hash=xxx, or ledger=closed|current|validated  
 *    limit limit output tx record
 *    ledger_min default 0, ledger_max default -1
 *    marker: {ledger:xxx, seq: x}
 *    descending, if returns recently tx records
 * @returns {Request}
 */
Remote.prototype.requestAccountTx = function(options) {
    var request = new Request(this, 'account_tx', function(data) {
        var results = [];
        for (var i = 0; i < data.transactions.length; ++i) {
            var _tx = utils.processTx(data.transactions[i], options.account);
            results.push(_tx);
        }
        data.transactions = results;
        return data;
    });

    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    if (!utils.isValidAddress(options.account)) {
        request.message.account = new Error('account parameter is invalid');
        return request;
    }
    request.message.account = options.account;

    if (options.ledger_min && Number(options.ledger_min)) {
        request.message.ledger_index_min = Number(options.ledger_min);
    } else {
        request.message.ledger_index_min = 0;
    }
    if (options.ledger_max && Number(options.ledger_max)) {
        request.message.ledger_index_max = Number(options.ledger_max);
    } else {
        request.message.ledger_index_max = -1;
    }
    if (options.limit && Number(options.limit)) {
        request.message.limit = Number(options.limit);
    }
    if (options.offset && Number(options.offset)) {
        request.message.offset = Number(options.offset);
    }
    if (typeof(options.marker) === 'object'
            && Number(options.marker.ledger) !== NaN && Number(options.marker.seq) !== NaN) {
        request.message.marker = options.marker;
    }
    if(options.forward && typeof options.forward === 'boolean'){//true 正向；false反向
        request.message.forward = options.forward;
    }
    return request;
};

/**
 * request order book,
 * options {gets: {currency: , issuer: }, pays: {currency: ', issuer: '}}
 * for order pair AAA/BBB
 *    to get bids, gets=AAA, pays=BBB
 *    to get asks, gets=BBB, pays=AAA
 * for bids orders are ordered by price desc
 * for asks orders are ordered by price asc
 * TODO format data
 * @param options
 * @returns {Request}
 */
Remote.prototype.requestOrderBook = function(options) {
    var request = new Request(this, 'book_offers');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    var taker_gets = options.taker_gets || options.pays;
    if (!utils.isValidAmount0(taker_gets)) {
        request.message.taker_gets = new Error('invalid taker gets amount');
        return request;
    }
    var taker_pays = options.taker_pays || options.gets;
    if (!utils.isValidAmount0(taker_pays)) {
        request.message.taker_pays = new Error('invalid taker pays amount');
        return request;
    }
    if (_.isNumber(options.limit)) {
        options.limit = parseInt(options.limit);
    }

    request.message.taker_gets = taker_gets;
    request.message.taker_pays = taker_pays;
    request.message.taker = options.taker ? options.taker : utils.ACCOUNT_ONE;
    request.message.limit = options.limit;
    return request;
};

/*
 * request brokerage,
 * @param options
 * @returns {Request}
* */
Remote.prototype.requestBrokerage = function(options) {
    var request = new Request(this, 'Fee_Info');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    var account = options.account;

    if (!utils.isValidAddress(account)) {
        request.message.account = new Error('account parameter is invalid');
        return request;
    }

    request.message.account = account;
    request.message.ledger_index = 'validated';
    return request;
};

Remote.prototype.requestSignerList = function(options) {
    var request = new Request(this, 'account_objects');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    var account = options.account;

    if (!utils.isValidAddress(account)) {
        request.message.account = new Error('account parameter is invalid');
        return request;
    }

    request.message.account = account;
    return request;
};

/**
 * @param options
 * {
 *   account(option): the query account
 *   marker(option):  for more black account
 * }
 * @returns {Request}
 */
Remote.prototype.requestBlacklist = function(options) {
    var request = new Request(this, 'blacklist_info');

    if(!options){
        return request;
    }
    if (options && typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    var account = options.account;
    if(account && !utils.isValidAddress(account)){
        request.message.account = new Error('invalid account');
        return request;
    }
    if (options.marker) {
        request.message.marker = options.marker;
    }
    request.message.account = account;
    return request;
};
// ---------------------- path find request --------------------
/**
 * @param options
 * {
 *   account: acccount|from|source, account to find path
 *   destination: destination|to|dst, destiantion account
 *   amount: the amount destination will received
 * }
 * @returns {Request}
 */
Remote.prototype.requestPathFind = function(options) {
    var self = this;
    var request = new Request(self, 'path_find', function(data) {
        var request2 = new Request(self, 'path_find');
        request2.message.subcommand = 'close';
        request2.submit();
        var _result = [];
        for (var i = 0; i < data.alternatives.length; ++i) {
            var item = data.alternatives[i];
            var key = sha1(JSON.stringify(item));
            self._paths.set(key, {
                path: JSON.stringify(item.paths_computed),
                choice: item.source_amount
            });
            _result.push({
                choice: utils.parseAmount(item.source_amount),
                key: key
            });
        }
        return _result;
    });
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }

    var account = options.account;
    var dest = options.destination;
    var amount = options.amount;

    if (!utils.isValidAddress(account)) {
        request.message.source_account = new Error('invalid source account');
        return request;
    }
    if (!utils.isValidAddress(dest)) {
        request.message.destination_account = new Error('invalid destination account');
        return request;
    }
    if ((!utils.isValidAmount(amount))) {
        request.message.destination_amount = new Error('invalid amount');
        return request;
    }

    request.message.subcommand = 'create';
    request.message.source_account = account;
    request.message.destination_account = dest;
    request.message.destination_amount = ToAmount(amount);
    return request;
};

// ---------------------- subscribe --------------------
/**
 * @param streams
 * @returns {Request}
 */
Remote.prototype.subscribe = function(streams) {
    var request = new Request(this, 'subscribe');
    if (streams) {
        request.message.streams = Array.isArray(streams) ? streams : [streams];
    }
    return request;
};

/**
 * @param streams
 * @returns {Request}
 */
Remote.prototype.unsubscribe = function(streams) {
    var request = new Request(this, 'unsubscribe');
    if (streams) {
        request.message.streams = Array.isArray(streams) ? streams : [streams];
    }
    return request;
};

/**
 * stub function for account event
 * @returns {Account}
 */
Remote.prototype.createAccountStub = function() {
    return new Account(this);
};

/** stub function for order book
 *
 * @returns {OrderBook}
 */
Remote.prototype.createOrderBookStub = function() {
    return new OrderBook(this);
};

// ---------------------- transaction request --------------------
/**
 * return string if swt amount
 * @param amount
 * @returns {Amount}
 */
function ToAmount(amount) {
    if(amount.value && Number(amount.value) > 100000000000){
        return new Error('invalid amount: amount\'s maximum value is 100000000000');
    }
    if (amount.currency === currency) {
        // return new String(parseInt(Number(amount.value) * 1000000.00));
        return String(parseInt(new bignumber(amount.value).multipliedBy(1000000.00)));
    }
    return amount;
}

/**
 * payment
 * @param options
 *    source|from|account source account, required
 *    destination|to destination account, required
 *    amount payment amount, required
 * @returns {Transaction}
 */
Remote.prototype.buildPaymentTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var src = options.source || options.from || options.account;
    var dst = options.destination || options.to;
    var amount = options.amount;
    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }
    if (!utils.isValidAddress(dst)) {
        tx.tx_json.dst = new Error('invalid destination address');
        return tx;
    }
    if (!utils.isValidAmount(amount)) {
        tx.tx_json.amount = new Error('invalid amount');
        return tx;
    }

    tx.tx_json.TransactionType = 'Payment';
    tx.tx_json.Account = src;
    tx.tx_json.Amount = ToAmount(amount);
    tx.tx_json.Destination = dst;
    return tx
};

Remote.prototype.initContract = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var account = options.account;
    var amount = options.amount;
    var payload = options.payload;
    var params = options.params || [];
    var abi = options.abi;
    if (!utils.isValidAddress(account)) {
        tx.tx_json.account = new Error('invalid address');
        return tx;
    }
    if (isNaN(amount)) {
        tx.tx_json.amount = new Error('invalid amount');
        return tx;
    }
    if(typeof payload !== 'string'){
        tx.tx_json.payload = new Error('invalid payload: type error.');
        return tx;
    }
    if (!Array.isArray(params)) {
        tx.tx_json.params =  new Error('invalid params: type error.');
        return tx;
    }
    if (!abi) {
        tx.tx_json.abi =  new Error('not found abi');
        return tx;
    }
    if (!Array.isArray(abi)) {
        tx.tx_json.params =  new Error('invalid abi: type error.');
        return tx;
    }

    var tum3 = new Tum3();
    tum3.mc.defaultAccount = account;
    var MyContract = tum3.mc.contract(abi);
    var contractData = MyContract.new.getData.apply(null, params.concat({data: payload}));

    tx.tx_json.TransactionType = 'AlethContract';
    tx.tx_json.Account = account;
    tx.tx_json.Amount = Number(amount) * 1000000;
    tx.tx_json.Method = 0;
    tx.tx_json.Payload = utils.stringToHex(contractData);
    return tx
};

Remote.prototype.invokeContract = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }
    var account = options.account;
    var des = options.destination;
    var func = options.func; //函数名及函数参数
    var abi = options.abi;
    var amount = options.amount;


    if (!utils.isValidAddress(account)) {
        tx.tx_json.account = new Error('invalid address');
        return tx;
    }
    if (!utils.isValidAddress(des)) {
        tx.tx_json.des = new Error('invalid destination');
        return tx;
    }
    if(typeof func !== 'string' || func.indexOf('(') < 0  || func.indexOf(')') < 0){
        tx.tx_json.func =  new Error('invalid func, func must be string');
        return tx;
    }
    if (!abi) {
        tx.tx_json.abi =  new Error('not found abi');
        return tx;
    }
    if (!Array.isArray(abi)) {
        tx.tx_json.params =  new Error('invalid abi: type error.');
        return tx;
    }
    if(amount && isNaN(amount)){
        tx.tx_json.amount =  new Error('invalid amount: amount must be a number.');
        return tx;
    }

    if(amount){
        abi.forEach(function (a) {
            if(a.name === func.substring(0, func.indexOf('(')) && !a.payable){
                tx.tx_json.amount =  new Error('when payable is true, you can set the value of amount');
                return tx;
            }
        })
    }


    var tum3 = new Tum3();
    tum3.mc.defaultAccount = account;
    var MyContract = tum3.mc.contract(abi);
    tx.abi = abi;
    var myContractInstance = MyContract.at(des);// initiate contract for an address
    try {
        var result = eval('myContractInstance.' + func);// call constant function
    }catch (e){
        console.log('not found this function.' + e);
    }

    if(!result){
        tx.tx_json.des = new Error('invalid func, no result');
        return tx;
    }
    tx.tx_json.TransactionType = 'AlethContract';
    tx.tx_json.Account = account;
    tx.tx_json.Method = 1;
    tx.tx_json.Destination = des;
    tx.tx_json.Amount = options.amount ? options.amount: 0;
    tx.tx_json.MethodSignature = utils.stringToHex(func);
    tx.tx_json.Args = [];
    tx.tx_json.Args.push({Arg: {Parameter: utils.stringToHex(result.substr(2,result.length)), ContractParamsType:0}});
    return tx;
};

Remote.prototype.AlethEvent = function(options) {
    var request =  new Request(this, 'aleth_eventlog', function(data) {
        return data;
    });

    if (typeof options !== 'object') {
        request.message.obj =  new Error('invalid options type');
        return request;
    }
    var des = options.destination;
    var abi = options.abi;

    if (!utils.isValidAddress(des)) {
        request.message.des = new Error('invalid destination');
        return request;
    }
    if (!abi) {
        request.message.abi =  new Error('not found abi');
        return request;
    }
    if (!Array.isArray(abi)) {
        request.message.params =  new Error('invalid abi: type error.');
        return request;
    }
    this.abi = abi;
    request.message.Destination = des;
    return request;
};
/**
 * contract
 * @param options
 *    account, required
 *    amount, required
 *    payload, required
 * @returns {Transaction}
 */
Remote.prototype.deployContractTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var account = options.account;
    var amount = options.amount;
    var payload = options.payload;
    var params = options.params;
    if (!utils.isValidAddress(account)) {
        tx.tx_json.account = new Error('invalid address');
        return tx;
    }
    if (isNaN(amount)) {
        tx.tx_json.amount = new Error('invalid amount');
        return tx;
    }
    if(typeof payload !== 'string'){
        tx.tx_json.payload = new Error('invalid payload: type error.');
        return tx;
    }
    if (params && !Array.isArray(params)) {
        tx.tx_json.params =  new Error('invalid options type');
        return tx;
    }

    tx.tx_json.TransactionType = 'ConfigContract';
    tx.tx_json.Account = account;
    tx.tx_json.Amount = Number(amount) * 1000000;
    tx.tx_json.Method = 0;
    tx.tx_json.Payload = payload;
    tx.tx_json.Args = [];
    for(var i in params){
        var obj = {};
        obj.Arg = {Parameter : utils.stringToHex(params[i])};
        tx.tx_json.Args.push(obj);
    }
    return tx
};

/**
 * contract
 * @param options
 *    account, required
 *    des, required
 *    params, required
 * @returns {Transaction}
 */
Remote.prototype.callContractTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }
    var account = options.account;
    var des = options.destination;
    var params = options.params;
    var func = options.func; //函数名
    if (!utils.isValidAddress(account)) {
        tx.tx_json.account = new Error('invalid address');
        return tx;
    }
    if (!utils.isValidAddress(des)) {
        tx.tx_json.des = new Error('invalid destination');
        return tx;
    }

    if (params && !Array.isArray(params)) {
        tx.tx_json.params =  new Error('invalid options type');
        return tx;
    }
    if(typeof func !== 'string'){
        tx.tx_json.func =  new Error('func must be string');
        return tx;
    }

    tx.tx_json.TransactionType = 'ConfigContract';
    tx.tx_json.Account = account;
    tx.tx_json.Method = 1;
    tx.tx_json.ContractMethod = utils.stringToHex(func);
    tx.tx_json.Destination = des;
    tx.tx_json.Args = [];
    for(var i in params){
        if(typeof params[i] !== 'string'){
            tx.tx_json.params =  new Error('params must be string');
            return tx;
        }
        var obj = {};
        obj.Arg = {Parameter : utils.stringToHex(params[i])};
        tx.tx_json.Args.push(obj);
    }
    return tx;
};

Remote.prototype.buildSignTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }

    tx.tx_json.TransactionType = 'Signer';
    tx.tx_json.blob = options.blob;

    return tx;
};

/**
 * Brokerage 设置挂单手续费
 * @param options
 *    account, required
 *    mol|molecule, required
 *    den|denominator, required
 *    app, required
 *    amount, required
 * @returns {Transaction}
 */
Remote.prototype.buildBrokerageTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var account = options.account;
    var feeAccount = options.feeAccount;
    var mol = (Number(options.mol) === 0 || Number(options.molecule) === 0) ? 0 : (options.mol || options.molecule);
    var den = options.den || options.denominator;
    var amount = options.amount;
    if (!utils.isValidAddress(account)) {
        tx.tx_json.src = new Error('invalid address');
        return tx;
    }
    if(!/^\d+$/.test(mol)){//(正整数 + 0)
        tx.tx_json.mol = new Error('invalid mol, it is a positive integer or zero.');
        return tx;
    }

    if(Number(mol) > Number(den)){
        tx.tx_json.app = new Error('invalid mol/den, molecule can not exceed denominator.');
        return tx;
    }
    if (!utils.isValidAmount(amount)) {
        tx.tx_json.amount = new Error('invalid amount');
        return tx;
    }

    tx.tx_json.TransactionType = 'Brokerage';
    tx.tx_json.Account = account; //管理员账号
    tx.tx_json.OfferFeeRateNum = Number(mol); //分子(正整数 + 0)
    tx.tx_json.OfferFeeRateDen = Number(den); //分母(正整数)
    tx.tx_json.Amount = ToAmount(amount); //币种,这里amount字段中的value值只是占位，没有实际意义。
    tx.tx_json.FeeAccountID = feeAccount; //收费账号

    return tx;
};

Remote.prototype.__buildTrustSet = function(options, tx) {
    // var tx = new Transaction(this);
    // if (typeof options !== 'object') {
    //     tx.tx_json.obj =  new Error('invalid options type');
    //     return tx;
    // }
    var src = options.source || options.from || options.account;
    var limit = options.limit;
    var quality_out = options.quality_out;
    var quality_in = options.quality_in;

    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }
    if (!utils.isValidAmount(limit)) {
        tx.tx_json.limit = new Error('invalid amount');
        return tx;
    }

    tx.tx_json.TransactionType = 'TrustSet';
    tx.tx_json.Account = src;
    if (limit !== void(0)) {
        tx.tx_json.LimitAmount = limit;
    }
    if (quality_in) {
        tx.tx_json.QualityIn = quality_in;
    }
    if (quality_out) {
        tx.tx_json.QualityOut = quality_out;
    }
    return tx;
};

Remote.prototype.__buildRelationSet = function(options, tx) {
    // TODO
    // var tx = new Transaction(this);
    // if (typeof options !== 'object') {
    //     tx.tx_json.obj =  new Error('invalid options type');
    //     return tx;
    // }

    var src = options.source || options.from || options.account;
    var des = options.target;
    var limit = options.limit;

    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }
    if (!utils.isValidAddress(des)) {
        tx.tx_json.des = new Error('invalid target address');
        return tx;
    }
    if (!utils.isValidAmount(limit)) {
        tx.tx_json.limit = new Error('invalid amount');
        return tx;
    }

    tx.tx_json.TransactionType =  options.type === 'unfreeze' ? 'RelationDel' : 'RelationSet';
    tx.tx_json.Account = src;
    tx.tx_json.Target = des;
    tx.tx_json.RelationType = options.type === 'authorize' ? 1 : 3;
    if (limit !== void(0)) {
        tx.tx_json.LimitAmount = limit;
    }
    return tx;
};

/**
 * add wallet relation set
 * @param options
 *    type: Transaction.RelationTypes
 *    source|from|account source account, required
 *    limit limt amount, required
 *    quality_out, optional
 *    quality_in, optional
 * @returns {Transaction}
 */
Remote.prototype.buildRelationTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }
    if (!~Transaction.RelationTypes.indexOf(options.type)) {
        tx.tx_json.type = new Error('invalid relation type');
        return tx;
    }
    switch (options.type) {
        case 'trust':
            return this.__buildTrustSet(options, tx);
        case 'authorize':
        case 'freeze':
        case 'unfreeze':
            return this.__buildRelationSet(options, tx);
    }
    tx.tx_json.msg = new Error('build relation set should not go here');
    return tx;
};

/**
 * account information set
 * @param options
 *    set_flag, flags to set
 *    clear_flag, flags to clear
 * @returns {Transaction}
 */
Remote.prototype.__buildAccountSet = function(options, tx) {
    // var tx = new Transaction(this);
    // if (typeof options !== 'object') {
    //     tx.tx_json.obj =  new Error('invalid options type');
    //     return tx;
    // }

    var src = options.source || options.from || options.account;
    var set_flag = options.set_flag || options.set;
    var clear_flag = options.clear_flag || options.clear;
    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }

    tx.tx_json.TransactionType= 'AccountSet';
    tx.tx_json.Account = src;

    var SetClearFlags = Transaction.set_clear_flags.AccountSet;

    function prepareFlag(flag) {
        return (typeof flag === 'number')
            ? flag : (SetClearFlags[flag] || SetClearFlags['asf' + flag]);
    }

    if (set_flag && (set_flag = prepareFlag(set_flag))) {
        tx.tx_json.SetFlag = set_flag;
    }

    if (clear_flag && (clear_flag = prepareFlag(clear_flag))) {
        tx.tx_json.ClearFlag = clear_flag;
    }

    return tx;
};

/**
 * delegate key setting
 * @param options
 *    source|account|from, source account, required
 *    delegate_key, delegate account, required
 * @returns {Transaction}
 */
Remote.prototype.__buildDelegateKeySet = function(options, tx) {
    // var tx = new Transaction(this);
    // if (typeof options !== 'object') {
    //     tx.tx_json.obj =  new Error('invalid options type');
    //     return tx;
    // }

    var src = options.source || options.account || options.from;
    var delegate_key = options.delegate_key;

    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }
    if (!utils.isValidAddress(delegate_key)) {
        tx.tx_json.delegate_key = new Error('invalid regular key address');
        return tx;
    }

    tx.tx_json.TransactionType = 'SetRegularKey';
    tx.tx_json.Account = src;
    tx.tx_json.RegularKey = delegate_key;

    return tx;
};

Remote.prototype.__buildSignerSet = function(options, tx) {
    // TODO
    return null;
};

/**
 * account information set
 * @param options
 *    type: Transaction.AccountSetTypes
 * @returns {Transaction}
 */
Remote.prototype.buildAccountSetTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }
    if (Transaction.AccountSetTypes.indexOf(options.type) === -1) {
        tx.tx_json.type = new Error('invalid account set type');
        return tx;
    }
    switch(options.type) {
        case 'property':
            return this.__buildAccountSet(options, tx);
        case 'delegate':
            return this.__buildDelegateKeySet(options, tx);
        case 'signer':
            return this.__buildSignerSet(options, tx);
    }

    tx.tx_json.msg = new Error('build account set should not go here');
    return tx;
};

/**
 * offer create
 * @param options
 *    type: 'Sell' or 'Buy'
 *    source|from|account maker account, required
 *    taker_gets|pays amount to take out, required
 *    taker_pays|gets amount to take in, required
 * @returns {Transaction}
 */
Remote.prototype.buildOfferCreateTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }

    var offer_type = options.type;
    var src = options.source || options.from || options.account;
    var taker_gets = options.taker_gets || options.pays;
    var taker_pays = options.taker_pays || options.gets;
    var platform = options.platform;//app平台标识账号

    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }
    if (typeof offer_type !== 'string' || !~Transaction.OfferTypes.indexOf(offer_type)) {
        tx.tx_json.offer_type = new Error('invalid offer type');
        return tx;
    }

    if (typeof taker_gets === 'string' && !Number(taker_gets)) {
        tx.tx_json.taker_gets = new Error('invalid to pays amount');
        return tx;
    }
    if (typeof taker_gets === 'object' && !utils.isValidAmount(taker_gets)) {
        tx.tx_json.taker_gets = new Error('invalid to pays amount object');
        return tx;
    }
    if (typeof taker_pays === 'string' && !Number(taker_pays)) {
        tx.tx_json.taker_pays = new Error('invalid to gets amount');
        return tx;
    }
    if (typeof taker_pays === 'object' && !utils.isValidAmount(taker_pays)) {
        tx.tx_json.taker_pays = new Error('invalid to gets amount object');
        return tx;
    }
    if(platform && !utils.isValidAddress(platform)) {
        tx.tx_json.platform = new Error('invalid platform, it must be a valid address.');
        return tx;
    }

    tx.tx_json.TransactionType = 'OfferCreate';
    if (offer_type === 'Sell') tx.setFlags(offer_type);
    if(platform) tx.tx_json.Platform = platform;
    tx.tx_json.Account = src;
    tx.tx_json.TakerPays = typeof taker_pays === 'object' ? ToAmount(taker_pays) : taker_pays;
    tx.tx_json.TakerGets = typeof taker_gets === 'object' ? ToAmount(taker_gets) : taker_gets;

    return tx;
};

/**
 * offer cancel
 * @param options
 *    source|from|account source account, required
 *    sequence, required
 * @returns {Transaction}
 */
Remote.prototype.buildOfferCancelTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj =  new Error('invalid options type');
        return tx;
    }

    var src = options.source || options.from || options.account;
    var sequence = options.sequence;

    if (!utils.isValidAddress(src)) {
        tx.tx_json.src = new Error('invalid source address');
        return tx;
    }
    if (!Number(sequence)) {
        tx.tx_json.sequence = new Error('invalid sequence param');
        return tx;
    }

    tx.tx_json.TransactionType = 'OfferCancel';
    tx.tx_json.Account = src;
    tx.tx_json.OfferSequence = Number(sequence);

    return tx;
};


Remote.prototype.buildSignerListTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var account =  options.account;
    var threshold = options.threshold;//阈值
    var lists = options.lists; //签字人列表
    if (!utils.isValidAddress(account)) {
        tx.tx_json.src = new Error('invalid address');
        return tx;
    }
    if (isNaN(threshold) || Number(threshold) < 0) {
        tx.tx_json.threshold = new Error('invalid threshold, it must be a number and greater than zero');
        return tx;
    }
    if (lists && !Array.isArray(lists)) {
        tx.tx_json.lists =  new Error('invalid options type, it must be an array');
        return tx;
    }
    if(Number(threshold) === 0 && lists && lists.length >= 0){
        tx.tx_json.lists =  new Error('please delete lists when threshold is zero');
        return tx;
    }
    var sum = 0;
    if(Number(threshold) !== 0 && lists && lists.length > 0){
        var newList = [];
        for(var i = 0; i < lists.length; i++){
            if(lists[i].account && utils.isValidAddress(lists[i].account) && lists[i].weight && !isNaN(lists[i].weight) && Number(lists[i].weight) > 0){
                sum += Number(lists[i].weight);
                newList.push({
                    SignerEntry:{
                        Account: lists[i].account,
                        SignerWeight: lists[i].weight
                    }
                });
            }else {
                tx.tx_json.lists =  new Error('invalid lists');
                return tx;
            }
        }
        tx.tx_json.SignerEntries = newList;
    }
    if(sum < Number(threshold)){
        tx.tx_json.threshold =  new Error('The total signer weight is less than threshold');
        return tx;
    }
    tx.tx_json.TransactionType = 'SignerListSet';
    tx.tx_json.Account = account;
    tx.tx_json.SignerQuorum = Number(threshold);

    return tx;
};

Remote.prototype.buildSignFirstTx = function(options) {//首签账号添加SigningPubKey字段
    options.tx.setCommand('sign_for');
    options.tx.tx_json.SigningPubKey = '';
    options.tx.sign_account = options.account;
    options.tx.sign_secret = options.secret;
    return options.tx;
};
Remote.prototype.buildSignOtherTx = function(options) {//其他账号签名只需把返回结果提交回去即可
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.options =  new Error('invalid options type');
        return tx;
    }
    tx.setCommand('sign_for');
    tx.tx_json = options.tx_json;
    tx.sign_account = options.account;
    tx.sign_secret = options.secret;
    return tx;
};

Remote.prototype.buildMultisignedTx = function(tx_json) {//提交多重签名
    var tx = new Transaction(this);
    if (tx_json === null || typeof tx_json !== 'object') {
        tx.tx_json.tx_json =  new Error('invalid tx_json type');
        return tx;
    }
    tx.setCommand('submit_multisigned');
    tx.tx_json = tx_json;
    return tx;
};
Remote.prototype.buildTx = function(tx_json) {//多重签名中通过tx_json创建Transaction对象
    var tx = new Transaction(this);
    if (tx_json === null || typeof tx_json !== 'object') {
        tx.tx_json.tx_json =  new Error('invalid tx_json type');
        return tx;
    }
    tx.tx_json = tx_json;
    return tx;
};

Remote.prototype.buildTokenIssueTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var account =  options.account;
    var publisher = options.publisher;
    var token = options.token;
    var number = options.number;
    if (!utils.isValidAddress(account)) {
        tx.tx_json.account = new Error('invalid account address');
        return tx;
    }
    if (!utils.isValidAddress(publisher)) {
        tx.tx_json.publisher = new Error('invalid publisher address');
        return tx;
    }
    if (isNaN(number) || Number(number) < 0) {
        tx.tx_json.number = new Error('invalid number, it must be a number and greater than zero');
        return tx;
    }

    tx.tx_json.TransactionType = 'TokenIssue';
    tx.tx_json.Account = account;
    tx.tx_json.Issuer = publisher;
    tx.tx_json.FundCode	 = utils.stringToHex(utf8.encode(token));
    tx.tx_json.TokenSize = Number(number);
    return tx;
};
Remote.prototype.requestTokenIssue = function(options) {
    var request = new Request(this, 'erc_issue');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    var publisher = options.publisher;

    if (!utils.isValidAddress(publisher)) {
        request.message.account = new Error('publisher is invalid');
        return request;
    }

    request.message.account = publisher;
    request.message.ledger_index = 'validated';
    return request;
};

Remote.prototype.buildTransferTokenTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }
    var publisher = options.publisher;
    var receiver = options.receiver;
    var token = options.token;
    var tokenId = options.tokenId;
    var memos = options.memos;
    if (!utils.isValidAddress(receiver)) {
        tx.tx_json.receiver = new Error('invalid receiver address');
        return tx;
    }
    if (!utils.isValidAddress(publisher)) {
        tx.tx_json.publisher = new Error('invalid publisher address');
        return tx;
    }

    var ms = [];
    if (Array.isArray(memos) && memos.length > 0) {
        memos.forEach(function (m) {
            ms.push({Memo: {MemoType: utils.stringToHex(utf8.encode(m.type)), MemoData: utils.stringToHex(utf8.encode(m.data))}});
        })
    }

    tx.tx_json.TransactionType = 'TransferToken';
    tx.tx_json.Account = publisher;
    tx.tx_json.Destination = receiver;
    if(token)
        tx.tx_json.FundCode	 = utils.stringToHex(utf8.encode(token));
    if(ms.length > 0)
        tx.tx_json.Memos = ms;
    tx.tx_json.TokenID = tokenId;//64位，不足的补零吗？

    return tx;
};
Remote.prototype.requestAccountToken = function(options) {
    var request = new Request(this, 'account_erc');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }
    var account = options.account;

    if (!utils.isValidAddress(account)) {
        request.message.account = new Error('account is invalid');
        return request;
    }

    request.message.account = account;
    request.message.ledger_index = 'validated';
    return request;
};
Remote.prototype.requestTokenInfo = function(options) {
    var request = new Request(this, 'erc_info');
    if (options === null || typeof options !== 'object') {
        request.message.type = new Error('invalid options type');
        return request;
    }

    request.message.tokenid = options.tokenId;
    request.message.ledger_index = 'validated';
    return request;
};

Remote.prototype.buildTokenDelTx = function(options) {
    var tx = new Transaction(this);
    if (options === null || typeof options !== 'object') {
        tx.tx_json.obj = new Error('invalid options type');
        return tx;
    }

    var publisher = options.publisher;
    var tokenId = options.tokenId;

    if (!utils.isValidAddress(publisher)) {
        tx.tx_json.publisher = new Error('invalid publisher address');
        return tx;
    }

    tx.tx_json.TransactionType = 'TokenDel';
    tx.tx_json.Account = publisher;
    tx.tx_json.TokenID = tokenId;

    return tx;
};

module.exports = Remote;

