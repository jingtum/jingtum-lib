var jlib = require('./jingtum-lib');
var Remote = jlib.Remote;
var utils = jlib.utils;
var remote = new Remote({server: 'ws://101.200.230.74:5020'}); //多重签名


// remote.connect(function(err, result) {
//     if (err) {
//         return console.log('err******', err);
//     }

    var root = {
        'secret': 'snoPBjXtMeMyMHUVTgbuqAfg1SUTb',//合约根账号
        'address': 'jHb9CJAWyB4jr91VRWn96DkukG4bwdtyTh'
    };

    var a1 = {address: 'j3yeaNQUqMmrDb1T1p6Q2qHm9BHaAAmSwb', secret: 'ssRi4kAuYJvsdiaVWCn5vYDtbBnGT'};
    var a2 = {address: 'jJwkfLEVTkM6u3J7kWoATFd5aauBw5S8Kz', secret: 'ssLHnWZyTuoWaJ7MoF2BoiKGtJbSy'};

    //设置签名列表
/*    var req = remote.buildSignerListTx({
        account: root.address,
        threshold: 3,
        lists: [{
            account: a1.address,
            weight: 2
        },
            {account: a2.address,
            weight: 2},
            {
                account: a3.address,
                weight:2
            }
            ]
    });
    req.setSecret(root.secret);*/

    //1.自己组织交易
    // var tx = remote.buildPaymentTx({
    //     account: root.address, to: a1.address, amount: {
    //         "value": "2",
    //         "currency": "SWT",
    //         "issuer": ""
    //     }
    // });
    //
    // // tx.setSecret(root.secret);
    // // tx.addMemo('支付test');
    // tx.setSequence(11);
    // tx.setFee(100000); //需补六个零

    // tx.MultiSigning({ //第一个用户签名,该方法可罗列多个
    //     address: a1.address,
    //     secret: a1.secret
    // });


    //2.组织好的交易
    var tx_json = { Flags: 0,
        Fee: 100000,
        TransactionType: 'Payment',
        Account: 'jHb9CJAWyB4jr91VRWn96DkukG4bwdtyTh',
        Amount: '2000000',
        Destination: 'j3yeaNQUqMmrDb1T1p6Q2qHm9BHaAAmSwb',
        Sequence: 11,
        SigningPubKey: '',
        Signers: [ { Signer:
            { Account: 'j3yeaNQUqMmrDb1T1p6Q2qHm9BHaAAmSwb',
                SigningPubKey: '03B61B9644843F1781F66D72C99840AD7BE4FAC713EF5AC73F30278B2287B7BBFF',
                TxnSignature: '3045022100DDC408965E9F62626BC6A0603A0D707B64E0157B84299414BCF8C560EDE776970220093CB723375F3725DC41FB5B207B2CEEE158D5D70A90F18BD10D330F637DB9A3' } } ] }
    var tx = remote.buildTx(tx_json);

    // tx.MultiSigning({ //第二个用户签名
    //     address: a2.address,
    //     secret: a2.secret
    // });

    tx.MultiSigned();//多重签名结束
    if(tx.tx_json.verifyTx && tx.tx_json.verifyTx.toString().indexOf('verify failed')){//验签结果
        console.log('verify failed');
    }else {
        console.log('verify success');
    }

    // console.log('tx_json: ', tx.tx_json);
    // console.log('Signers: ', tx.tx_json.Signers);
   // var tx = remote.requestAccountInfo({account: root.address}) //10
   // var tx = remote.requestTx({hash: '61D72EFF31C0EDDA04AC4D71CE0A277609487C795C117783B60C6C34EC91E242'})
   //  tx.submit(function (err, result) {
   //      if(err) console.log('err: ', err);
   //      console.log('result: ', result);
   //      // console.log(utils.processTx(result, result.Account));
   //      // console.log('result: ', result.tx_json.Signers);
   //  })
// });
