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

const toNano = (amount: string | BigNumber): string => new BigNumber(amount).shiftedBy(9).toFixed(0);

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
      amount: toNano('10'),
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
    expect(transaction.outMessages.length, 'Output message count').to.be.equal(1);
    expect(transaction.outMessages[0].dst?.toString(), 'Destination').to.be.equal(emptyAccount.toString());
    expect(transaction.outMessages[0].bounce, 'Bounce').to.be.false;
    expect(transaction.outMessages[0].value, 'Value').to.be.equal(toNano('1'));

    await subscriber.trace(transaction).finished();

    const emptyAccountBalance = await ever.getBalance(emptyAccount);
    expect(emptyAccountBalance, 'Target balance').to.be.equal(toNano('1'));
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
    expect(transaction.outMessages.length, 'Output message count').to.be.equal(1);
    expect(transaction.outMessages[0].dst?.toString(), 'Destination').to.be.equal(emptyAccount.toString());
    expect(transaction.outMessages[0].bounce, 'Bounce').to.be.false;
    expect(transaction.outMessages[0].value, 'Value').to.be.equal(toNano('1'));

    await subscriber.trace(transaction).finished();

    const emptyAccountBalance = await ever.getBalance(emptyAccount);
    expect(emptyAccountBalance, 'Target balance').to.be.equal(toNano('1'));
  });
});
