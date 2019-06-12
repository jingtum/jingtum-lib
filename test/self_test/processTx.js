var Remote = require('../../src/remote');
var utils = require('../../src/utils');
/*多方撮合结果过滤*/
var remote = new Remote({server: 'wss://hc.jingtum.com:5020'});
remote.connect(function(err, ret) {
    var request = remote.requestTx({hash: 'A5CC4F2F02DB7FA92E4B5203CAF91CD7B876528E15F08CECBABDEEE2F6CFB3FE'});
    request.submit(function(err, data) {
        if(err) console.log(err);
        console.log(utils.processTx(data, data.Account));
    });
});

/*
* 返回结果
* { date: 1557882160,
  hash: 'A5CC4F2F02DB7FA92E4B5203CAF91CD7B876528E15F08CECBABDEEE2F6CFB3FE',
  type: 'offernew',
  fee: '0.00001',
  result: 'tesSUCCESS',
  memos: [],
  offertype: 'sell',
  gets:
   { currency: 'JMOAC',
     issuer: 'jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or',
     value: '5' },
  pays:
   { currency: 'CNY',
     issuer: 'jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or',
     value: '0.005' },
  seq: 2323,
  price: 0.001,  //挂单价格
  effects:
   [ { effect: 'offer_bought',
       counterparty: [Object],
       paid: [Object],
       got: [Object],
       type: 'sold',
       price: '910' },
     { effect: 'offer_bought',
       counterparty: [Object],
       paid: [Object],
       got: [Object],
       type: 'sold',
       price: '0.00552' } ],
  dealGets: //实际对方获得的
   { value: 5,
     currency: 'JMOAC',
     issuer: 'jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or' },
  dealPays: //实际对方支付的
   { value: 25.116,
     currency: 'CNY',
     issuer: 'jGa9J9TkqtBcUoHe2zqhVFFbgUVED6o9or' },
  dealPrice: 5.0232, //实际成交价格
  dealNum: 3 //多方撮合（币种）
  }
* */