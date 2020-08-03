'use strict';
var util = require('util');
var Event = require('events').EventEmitter;
var utf8 = require('utf8');
var utils = require('./utils');
var baselib = require('jingtum-base-lib').Wallet;
var jser = require('../lib/Serializer').Serializer;
const fee = require('./config').fee || 10000;
const MUTIPREFIX = 0x534d5400; //多重签名前缀

/**
 * Post request to server with account secret
 * @param remote
 * @constructor
 */
function Transaction(remote, filter) {
    Event.call(this);

    var self = this;
    self._remote = remote;
    self.tx_json = {Flags: 0, Fee: fee};
    self._filter = filter || function(v) {return v};
    self._secret = void(0);
    self.abi = void(0);
    self.command = 'submit';
    self.sign_account = void(0);
    self.sign_secret = void(0);
}
util.inherits(Transaction, Event);

Transaction.set_clear_flags = {
    AccountSet: {
        asfRequireDest:    1,
        asfRequireAuth:    2,
        asfDisallowSWT:    3,
        asfDisableMaster:  4,
        asfNoFreeze:       6,
        asfGlobalFreeze:   7
    }
};

Transaction.flags = {
  // Universal flags can apply to any transaction type
  Universal: {
    FullyCanonicalSig:  0x80000000
  },

  AccountSet: {
    RequireDestTag:     0x00010000,
    OptionalDestTag:    0x00020000,
    RequireAuth:        0x00040000,
    OptionalAuth:       0x00080000,
    DisallowSWT:        0x00100000,
    AllowSWT:           0x00200000
  },

  TrustSet: {
    SetAuth:            0x00010000,
    NoSkywell:          0x00020000,
    SetNoSkywell:       0x00020000,
    ClearNoSkywell:     0x00040000,
    SetFreeze:          0x00100000,
    ClearFreeze:        0x00200000
  },

  OfferCreate: {
    Passive:            0x00010000,
    ImmediateOrCancel:  0x00020000,
    FillOrKill:         0x00040000,
    Sell:               0x00080000
  },

  Payment: {
    NoSkywellDirect:    0x00010000,
    PartialPayment:     0x00020000,
    LimitQuality:       0x00040000
  },

  RelationSet:{
    Authorize:          0x00000001,
    Freeze:             0x00000011
  }
};


Transaction.OfferTypes = ['Sell', 'Buy'];
Transaction.RelationTypes = ['trust', 'authorize', 'freeze', 'unfreeze'];
Transaction.AccountSetTypes = ['property', 'delegate', 'signer'];

/**
 * parse json transaction as tx_json
 * @param val
 * @returns {Transaction}
 */
Transaction.prototype.parseJson = function(val) {
    this.tx_json = val;
    return this;
};

/**
 * get transaction account
 * @returns {Transaction.tx_json.Account}
 */
Transaction.prototype.getAccount = function() {
    return this.tx_json.Account;
};

/**
 * get transaction type
 * @returns {exports.result.TransactionType|*|string}
 */
Transaction.prototype.getTransactionType = function() {
    return this.tx_json.TransactionType;
};

/**
 * set secret
 * @param secret
 */
Transaction.prototype.setSecret = function(secret) {
    if(!baselib.isValidSecret(secret)){
        this.tx_json._secret = new Error('invalid secret');
        return;
    }
    this._secret = secret;
};

Transaction.prototype.setCommand = function(command) {
    this.command = command;
};

function __hexToString(h) {
    var a = [];
    var i = 0;

    if (h.length % 2) {
        a.push(String.fromCharCode(parseInt(h.substring(0, 1), 16)));
        i = 1;
    }

    for (; i<h.length; i+=2) {
        a.push(String.fromCharCode(parseInt(h.substring(i, i+2), 16)));
    }

    return a.join('');
}

function __stringToHex(s) {
    var result = '';
    for (var i=0; i<s.length; i++) {
        var b = s.charCodeAt(i);
        result += b < 16 ? '0' + b.toString(16) : b.toString(16);
    }
    return result;
}

/**
 * just only memo data
 * @param memo
 */
Transaction.prototype.addMemo = function(memo) {
    if (typeof  memo !== 'string') {
        this.tx_json.memo_type = new TypeError('invalid memo type');
        return this;
    }
    if (memo.length > 2048) {
        this.tx_json.memo_len = new TypeError('memo is too long');
        return this;
    }
    var _memo = {};
    _memo.MemoData = __stringToHex(utf8.encode(memo));
    this.tx_json.Memos = (this.tx_json.Memos || []).concat({Memo: _memo});
};

Transaction.prototype.setFee = function(fee) {
    var _fee = parseInt(fee);
    if (isNaN(_fee)) {
        this.tx_json.Fee = new TypeError('invalid fee');
        return this;
    }
    if (fee < 10) {
        this.tx_json.Fee = new TypeError('fee is too low');
        return this;
    }
    this.tx_json.Fee = _fee;
};


/**
 * set source tag
 * source tag is a 32 bit integer or undefined
 * @param tag
 */
 /*
Transaction.prototype.setSourceTag = function(tag) {
    if (typeof tag !== Number || !isFinite(tag)) {
        throw new Error('invalid tag type');
    }
    this.tx_json.SourceTag = tag;
};

Transaction.prototype.setDestinationTag = function(tag) {
    if (typeof tag !== Number || !isFinite(tag)) {
        throw new Error('invalid tag type');
    }
    this.tx_json.DestinationTag = tag;
};
*/

function MaxAmount(amount) {
    var utils = require('./utils');
    if (typeof amount === 'string' && Number(amount)) {
        var _amount = parseInt(Number(amount) * (1.0001));
        return String(_amount);
    }
    if (typeof amount === 'object' && utils.isValidAmount(amount)) {
        var _value = Number(amount.value) * (1.0001);
        amount.value = String(_value);
        return amount;
    }
    return new Error('invalid amount to max');
}

/**
 * set a path to payment
 * this path is repesented as a key, which is computed in path find
 * so if one path you computed self is not allowed
 * when path set, sendmax is also set.
 * @param path
 */
Transaction.prototype.setPath = function(key) {
    // sha1 string
    if (typeof key !== 'string' || key.length !== 40) {
        return new Error('invalid path key');
    }
    var item = this._remote._paths.get(key);
    if (!item) {
        return new Error('non exists path key');
    }
    if(item.path === '[]')//沒有支付路径，不需要传下面的参数
        return;
    var path = JSON.parse(item.path);
    this.tx_json.Paths = path;
    var amount = MaxAmount(item.choice);
    this.tx_json.SendMax = amount;
};

/**
 * limit send max amount
 * @param amount
 */
Transaction.prototype.setSendMax = function(amount) {
    if (!utils.isValidAmount(amount)) {
        return new Error('invalid send max amount');
    }
    this.tx_json.SendMax = amount;
};

/**
 * transfer rate
 * between 0 and 1, type is number
 * @param rate
 */
Transaction.prototype.setTransferRate = function(rate) {
    if (typeof rate !== 'number' || rate < 0 || rate > 1) {
        return new Error('invalid transfer rate');
    }
    this.tx_json.TransferRate = (rate + 1) * 1e9;
};


/**
 * set transaction flags
 *
 */
Transaction.prototype.setFlags = function(flags) {
    if (flags === void(0)) return;

    if (typeof flags === 'number') {
        this.tx_json.Flags = flags;
        return;
    }
    var transaction_flags = Transaction.flags[this.getTransactionType()] || {};
    var flag_set = Array.isArray(flags) ? flags : [].concat(flags);
    for (var i = 0; i < flag_set.length; ++i) {
        var flag = flag_set[i];
        if (transaction_flags.hasOwnProperty(flag)) {
            this.tx_json.Flags += transaction_flags[flag];
        }
    }
};

/* set sequence */
Transaction.prototype.setSequence = function(sequence) {
    if (!/^\+?[1-9][0-9]*$/.test(sequence)) {//正整数
        this.tx_json.Sequence = new TypeError('invalid sequence');
        return this;
    }

    this.tx_json.Sequence = Number(sequence);
};

function tx_json_filter(tx_json) {//签名时，序列化之前的字段处理
    tx_json.Fee = tx_json.Fee / 1000000;

    //payment
    if(tx_json.Amount && !isNaN(tx_json.Amount)){//基础货币
        tx_json.Amount = tx_json.Amount / 1000000;
    }
    if(tx_json.Memos){
        var memos = tx_json.Memos;
        for(var i = 0; i < memos.length; i++){
            memos[i].Memo.MemoData = utf8.decode(__hexToString(memos[i].Memo.MemoData));
            if(memos[i].Memo.MemoType)
                memos[i].Memo.MemoType = utf8.decode(__hexToString(memos[i].Memo.MemoType));
        }
    }
    if(tx_json.SendMax && !isNaN(tx_json.SendMax)){
        tx_json.SendMax = Number(tx_json.SendMax) / 1000000;
    }

    //order
    if(tx_json.TakerPays && !isNaN(tx_json.TakerPays)){//基础货币
        tx_json.TakerPays = Number(tx_json.TakerPays) / 1000000;
    }
    if(tx_json.TakerGets && !isNaN(tx_json.TakerGets)){//基础货币
        tx_json.TakerGets = Number(tx_json.TakerGets) / 1000000;
    }
}

function signing(self, callback) {
    try{
        tx_json_filter(self.tx_json);
        var wt = new baselib(self._secret);
        self.tx_json.SigningPubKey = wt.getPublicKey();
        var prefix = 0x53545800;
        var hash = jser.from_json(self.tx_json).hash(prefix);
        self.tx_json.TxnSignature = wt.signTx(hash);
        self.tx_json.blob =  jser.from_json(self.tx_json).to_hex();
        self._local_sign = true;
        callback(null, self.tx_json.blob);
    }catch (e){
        callback(e);
    }
}

function verifyTx(tx_json) {//验签
    var tx_json_new = JSON.parse(JSON.stringify(tx_json));
    tx_json_filter(tx_json_new);
    var signers = tx_json_new.Signers;
    delete tx_json_new.Signers;
    if(signers && signers.length > 0){
        for(var i = 0; i < signers.length; i++){
            var s = signers[i].Signer;
            var fromJson = jser.from_json(tx_json_new);
            fromJson = jser.adr_json(fromJson, s.Account);
            if(!baselib.checkTx(fromJson.hash(MUTIPREFIX), s.TxnSignature, s.SigningPubKey)){
                return false;
            }
        }
    }
    return true;
}
/*
* options: {
*   address: '',
*   secret: ''
* }
* */
Transaction.prototype.multiSigning = function (options) {
    if(!this.tx_json.Sequence){
        this.tx_json.Sequence = new Error('please set sequence first');
        return this;
    }

    var signers = this.tx_json.Signers || [];
    if(signers && signers.length > 0){//验签
        if(!verifyTx(this.tx_json)){
            this.tx_json.verifyTx = new Error('verify failed');
            return this;
        }
    }

    this.tx_json.SigningPubKey = '';//多签中该字段必须有且必须为空字符串
    var tx_json = JSON.parse(JSON.stringify(this.tx_json));
    tx_json_filter(tx_json);
    delete tx_json.Signers;
    var fromJson = jser.from_json(tx_json);
    var signer = {Account: options.account};
    fromJson = jser.adr_json(fromJson, options.account);
    var hash = fromJson.hash(MUTIPREFIX);
    var wt = new baselib(options.secret);
    signer.SigningPubKey = wt.getPublicKey();
    signer.TxnSignature = wt.signTx(hash);

    this.tx_json.Signers =  this.tx_json.Signers || [];
    this.tx_json.Signers.push({
        Signer: signer
    });
};

Transaction.prototype.multiSigned = function() {//多重签名完毕
    this.command = 'submit_multisigned';
    var signers = this.tx_json.Signers || [];
    if(signers && signers.length > 0){//验签
        if(!verifyTx(this.tx_json)){
            this.tx_json.verifyTx = new Error('verify failed');
            return this;
        }
    }
    if(Number(signers.length * fee) > Number(this.tx_json.Fee)){//验证燃料费是否够用
        this.tx_json.Fee =  new Error('low fee');
    }
};

Transaction.prototype.sign = function(callback) {
    var self = this;
    if(self.tx_json.Sequence){
        signing(self, callback);
        // callback(null, signing(self));
    }else {
        var req = this._remote.requestAccountInfo({account: self.tx_json.Account, type: 'trust'});
        req.submit(function (err,data) {
            if(err) return callback(err);
            self.tx_json.Sequence = data.account_data.Sequence;
            signing(self, callback);
            // callback(null, signing(self));
        });
    }
};

/**
 * submit request to server
 * @param callback
 */
Transaction.prototype.submit = function(callback) {
    var self = this;
    for(var key in self.tx_json){
        if(self.tx_json[key] instanceof Error){
            return callback(self.tx_json[key].message);
        }
    }
    if(self.command === 'submit_multisigned' || self.command === 'sign_for') // 多重签名按照不签名走
        self._remote._local_sign = false;
    var data = {};
    if(self.tx_json.TransactionType === 'Signer'){//直接将blob传给底层
        data = {
            tx_blob: self.tx_json.blob
        };
        self._remote._submit(self.command, data, self._filter, callback);
    } else if(self._remote._local_sign){//签名之后传给底层
        self.sign(function (err, blob) {
            if(err){
                return callback('sign error: ' + err);
            }else{
                var data = {
                    tx_blob: self.tx_json.blob,
                    abi: self.abi
                };
                self._remote._submit(self.command, data, self._filter, callback);
            }
        });
    }else{//不签名交易传给底层 和 多重签名提交
        data = {
            secret: self._secret,
            tx_json: self.tx_json,
            abi: self.abi
        };
        if(self.sign_account) data.account = self.sign_account;
        if(self.sign_secret) data.secret = self.sign_secret;
        self._remote._submit(self.command, data, self._filter, callback);
    }
};

module.exports = Transaction;
