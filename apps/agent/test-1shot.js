const data = {
  jsonrpc: '2.0',
  id: 3,
  method: 'relayer_send7710Transaction',
  params: {
    chainId: '84532',
    transactions: [
      {
        executions: [
          {
            target: '0x95C33523bD76E01Fa6E0bcfd655163727d0cC480',
            value: '0x0',
            data: '0x'
          }
        ],
        permissionContext: [
          {
            delegate: '0xf1ef956eff4181Ce913b664713515996858B9Ca9',
            delegator: '0x659A0aE49fa4f0f7E1Ed6F407B735287B50F60AB',
            authority: '0xe4c74f6df0a1c4b730500a5d21d809ca75c8d0684cddeba76b45fd1ca666a429',
            caveats: [],
            salt: '0xc2791c5b07501f0cd458c22e2e973453f54a59139b2976a883ec37a9e7799c1c',
            signature: '0x69c98805597ecb9d6df99dac7c8ca3e7d2db5637d8a6c18c6be167cde9851c6616c960da69d234f5f20764db5bc1ffe566e2d7dc7e86ed758719b71df269e8ae1b'
          },
          {
            delegate: '0x659A0aE49fa4f0f7E1Ed6F407B735287B50F60AB',
            delegator: '0x583e8d27a18D931dA234C2D75f36a3FF8c0627AA',
            authority: '0x0000000000000000000000000000000000000000000000000000000000000000',
            caveats: [
              {
                enforcer: '0x2DbF1eab62768134BBA672ed0bEb1BfEAE1a8a61',
                terms: '0x000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000004c4b40',
                args: '0x'
              }
            ],
            salt: '5236888251773479951820462287193718888524064840078850690388262295396074531346',
            signature: '0xe2d1452fe827300895c1dfca8fca8424febfb18c0dd02e437bf41e4ad859c8a5712666c1bd0ca0d07c9935848394f380c7fbfbd55808f61ef3947088b79e3d7f1c'
          }
        ]
      }
    ],
    context: "{\"chain\":84532,\"expiresAt\":1781371573,\"gasPrice\":\"7199999\",\"minFee\":\"0.01\",\"rate\":2000,\"signature\":\"lR7k6v0h8BjzSP6RbQJJYWjCn7CsTCmlEGxOLyShjVbq4rhXhFgXiPl3s0GBheWsXVwlHLj6AKN2bhmKD8z8Cw==\",\"tokenAddress\":\"0x036CbD53842c5426634e7929541eC2318f3dCF7e\",\"tokenDecimals\":6}"
  }
};
fetch('https://relayer.1shotapi.dev/relayers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
}).then(r => r.text()).then(console.log);
