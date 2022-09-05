import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'chai';
import BigNumber from 'bignumber.js';
import { Address, Contract, ProviderRpcClient } from 'everscale-inpage-provider';
import {
  EverscaleStandaloneClient,
  GiverAccount,
  SimpleAccountsStorage,
  SimpleKeystore,
} from 'everscale-standalone-client/nodejs';
import * as nt from 'nekoton-wasm';

import WalletAbi from '../dist/Wallet.abi';

const WALLET_CODE = fs.readFileSync(path.resolve(__dirname, '../dist/Wallet.code.boc')).toString('base64');

const giverAccount = GiverAccount.fromVersion(2);

const walletKey = SimpleKeystore.generateKeyPair();

const ever = new ProviderRpcClient({
  forceUseFallback: true,
  fallback: () =>
    EverscaleStandaloneClient.create({
      connection: 'local',
      accountsStorage: new SimpleAccountsStorage({
        entries: [giverAccount],
      }),
      keystore: new SimpleKeystore({
        giverKey: GiverAccount.GIVER_KEY_PAIR,
        walletKey,
      }),
    }),
});
const subscriber = new ever.Subscriber();

let stateInit: string;
let wallet: Contract<typeof WalletAbi>;

const toNano = (amount: number | string | BigNumber): string => new BigNumber(amount).shiftedBy(9).toFixed(0);

const makeEmptyAccount = (id: number): Address =>
  new Address(`0:${new BigNumber(`0x${walletKey.publicKey}`).plus(id).toString(16).padStart(64, '0')}`);

describe('Test wallet contract', async function () {
  before('Compute address and deposit funds', async function () {
    await ever.ensureInitialized();

    const { boc: data } = await ever.packIntoCell({
      structure: [
        { name: 'publicKey', type: 'uint256' },
        { name: 'timestamp', type: 'uint64' },
      ] as const,
      data: {
        publicKey: `0x${walletKey.publicKey}`,
        timestamp: 0,
      },
    });

    const { tvc } = await ever.mergeTvc({ data, code: WALLET_CODE });
    stateInit = tvc;

    const hash = await ever.getBocHash(tvc);
    const address = new Address(`0:${hash}`);
    wallet = new ever.Contract(WalletAbi, address);

    const { transaction } = await ever.sendMessage({
      sender: giverAccount.address,
      recipient: wallet.address,
      bounce: false,
      amount: toNano('100'),
    });
    await subscriber.trace(transaction).finished();
  });

  it('Simple transfer with deploy', async function () {
    const emptyAccount = makeEmptyAccount(0);

    const { transaction, output } = await wallet.methods
      .sendTransaction({
        dest: emptyAccount,
        bounce: false,
        value: toNano('1'),
        flags: 3,
        payload: '',
      })
      .sendExternal({
        publicKey: walletKey.publicKey,
        stateInit,
      });

    expect(output, 'Invalid output').to.be.empty;
    expect(transaction.origStatus, 'Original status').to.be.equal('uninit');
    expect(transaction.endStatus, 'End status').to.be.equal('active');
    expect(transaction.outMessages, 'Output message count').to.be.lengthOf(1);
    expect(transaction.outMessages[0].dst?.toString(), 'Destination').to.be.equal(emptyAccount.toString());
    expect(transaction.outMessages[0].bounce, 'Bounce').to.be.false;
    expect(transaction.outMessages[0].value, 'Value').to.be.equal(toNano('1'));
    expect(transaction.aborted, 'Aborted').to.be.false;

    await subscriber.trace(transaction).finished();

    const emptyAccountBalance = await ever.getBalance(emptyAccount);
    expect(emptyAccountBalance, 'Target balance').to.be.equal(toNano('1'));
  });

  it('Simple transfer with too big amount', async function () {
    const emptyAccount = makeEmptyAccount(0);

    const { transaction } = await wallet.methods
      .sendTransaction({
        dest: emptyAccount,
        bounce: false,
        value: toNano('10000000'),
        flags: 3,
        payload: '',
      })
      .sendExternal({
        publicKey: walletKey.publicKey,
      });

    expect(transaction.aborted, 'Aborted').to.be.false;
    expect(transaction.resultCode, 'Result code').to.be.eq(0);
    expect(transaction.outMessages, 'Output message count').to.be.empty;
  });

  it('Simple transfer with huge payload', async function () {
    const emptyAccount = makeEmptyAccount(0);

    const { transaction } = await wallet.methods
      .sendTransaction({
        dest: emptyAccount,
        bounce: false,
        value: toNano('1'),
        flags: 3,
        payload:
          'te6ccgECDAEABKMAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      })
      .sendExternal({
        publicKey: walletKey.publicKey,
      });

    expect(transaction.aborted, 'Aborted').to.be.false;
    expect(transaction.resultCode, 'Result code').to.be.eq(0);
    expect(transaction.outMessages, 'Output message count').to.be.lengthOf(1);

    await subscriber.trace(transaction).finished();
  });

  it('Correct signature check', async function () {
    const { transaction } = await wallet.methods
      .sendTransaction({
        dest: makeEmptyAccount(0),
        bounce: false,
        value: toNano('1'),
        flags: 3,
        payload: '',
      })
      .sendExternal({
        publicKey: walletKey.publicKey,
        stateInit,
        withoutSignature: true,
      });

    expect(transaction.aborted, 'Aborted').to.be.true;
    expect(transaction.exitCode, 'Exit code').to.be.equal(58);
  });

  it('Raw transfer', async function () {
    const emptyAccount = makeEmptyAccount(1);

    const { transaction, output } = await wallet.methods
      .sendTransactionRaw({
        flags: 3,
        message: nt.encodeInternalMessage(undefined, emptyAccount.toString(), false, undefined, undefined, toNano('1')),
      })
      .sendExternal({
        publicKey: walletKey.publicKey,
      });

    expect(output, 'Invalid output').to.be.empty;
    expect(transaction.outMessages, 'Output message count').to.be.lengthOf(1);
    expect(transaction.outMessages[0].dst?.toString(), 'Destination').to.be.equal(emptyAccount.toString());
    expect(transaction.outMessages[0].bounce, 'Bounce').to.be.false;
    expect(transaction.outMessages[0].value, 'Value').to.be.equal(toNano('1'));
    expect(transaction.aborted, 'Aborted').to.be.false;

    await subscriber.trace(transaction).finished();

    const emptyAccountBalance = await ever.getBalance(emptyAccount);
    expect(emptyAccountBalance, 'Target balance').to.be.equal(toNano('1'));
  });

  it('Empty raw transfer', async function () {
    const WalletAbi0 = {
      'ABI version': 2,
      version: '2.3',
      header: ['pubkey', 'time', 'expire'],
      functions: [
        {
          name: 'sendTransactionRaw',
          inputs: [],
          outputs: [],
          id: '0x169e3e11',
        },
      ],
      events: [],
    } as const;

    const wallet0 = new ever.Contract(WalletAbi0, wallet.address);
    const { transaction } = await wallet0.methods.sendTransactionRaw().sendExternal({
      publicKey: walletKey.publicKey,
    });

    expect(transaction.outMessages, 'Output message count').to.be.empty;
    expect(transaction.aborted, 'Aborted').to.be.false;
  });

  it('Raw transfer with multiple messages', async function () {
    const WalletAbi4 = {
      'ABI version': 2,
      version: '2.3',
      header: ['pubkey', 'time', 'expire'],
      functions: [
        {
          name: 'sendTransactionRaw',
          inputs: [
            { name: 'flags0', type: 'uint8' },
            { name: 'message0', type: 'cell' },
            { name: 'flags1', type: 'uint8' },
            { name: 'message1', type: 'cell' },
            { name: 'flags2', type: 'uint8' },
            { name: 'message2', type: 'cell' },
            { name: 'flags3', type: 'uint8' },
            { name: 'message3', type: 'cell' },
          ],
          outputs: [],
          id: '0x169e3e11',
        },
      ],
      events: [],
    } as const;

    const accountsOffset = 2;

    const makeMessageTo = (idx: number, value: string) =>
      nt.encodeInternalMessage(undefined, makeEmptyAccount(idx).toString(), false, undefined, undefined, toNano(value));

    const wallet4 = new ever.Contract(WalletAbi4, wallet.address);
    const { transaction } = await wallet4.methods
      .sendTransactionRaw({
        flags0: 3,
        message0: makeMessageTo(accountsOffset, '1'),
        flags1: 3,
        message1: makeMessageTo(accountsOffset + 1, '2'),
        flags2: 3,
        message2: makeMessageTo(accountsOffset + 2, '3'),
        flags3: 3,
        message3: makeMessageTo(accountsOffset + 3, '4'),
      })
      .sendExternal({
        publicKey: walletKey.publicKey,
      });

    expect(transaction.aborted, 'Aborted').to.be.false;
    expect(transaction.outMessages, 'Out message count').to.be.lengthOf(4);
    for (let idx = 0; idx < 4; ++idx) {
      expect(transaction.outMessages[idx].dst?.toString(), 'Destination').to.be.equal(
        makeEmptyAccount(accountsOffset + idx).toString(),
      );
      expect(transaction.outMessages[idx].bounce, 'Bounce').to.be.false;
      expect(transaction.outMessages[idx].value, 'Value').to.be.equal(toNano(idx + 1));
    }

    const childTxCount = await subscriber.trace(transaction).fold(0, c => c + 1);
    expect(childTxCount, 'Child transaction count').to.be.equal(4);
  });

  describe('Correct behavior for invalid data', async function () {
    const { state } = await ever.getFullContractState({ address: wallet.address });
    expect(state?.boc, 'Contract state').not.to.be.null;
  });
});
