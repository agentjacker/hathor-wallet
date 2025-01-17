import {
  helpers,
  Connection,
  HathorWallet,
  HathorWalletServiceWallet,
  wallet as oldWalletUtil,
  tokens as tokensUtils,
  constants as hathorLibConstants,
  config,
} from '@hathor/wallet-lib';
import {
  takeLatest,
  takeEvery,
  select,
  cancel,
  cancelled,
  all,
  put,
  call,
  race,
  take,
  fork,
  spawn,
} from 'redux-saga/effects';
import { eventChannel } from 'redux-saga';
import STORE from '../storageInstance';
import {
  WALLET_SERVICE_MAINNET_BASE_WS_URL,
  WALLET_SERVICE_MAINNET_BASE_URL,
} from '../constants';
import {
  FeatureFlags,
  Events as FeatureFlagEvents,
} from '../featureFlags';
import {
  types,
  isOnlineUpdate,
  loadingAddresses,
  lockWalletForResult,
  loadWalletSuccess,
  reloadData,
  metadataLoaded,
  tokenMetadataUpdated,
  setUseWalletService,
  updateLoadedData,
  setWallet,
  tokenFetchBalanceRequested,
  tokenFetchHistoryRequested,
  setServerInfo,
  startWalletFailed,
  walletStateError,
  walletStateReady,
  storeRouterHistory,
  reloadWalletRequested,
  reloadingWallet,
  tokenInvalidateHistory,
  sharedAddressUpdate,
  walletRefreshSharedAddress,
} from '../actions';
import { specificTypeAndPayload, errorHandler } from './helpers';
import { fetchTokenData } from './tokens';
import walletHelpers from '../utils/helpers';
import walletUtils from '../utils/wallet';

export const WALLET_STATUS = {
  READY: 'ready',
  FAILED: 'failed',
  LOADING: 'loading',
};

export function* startWallet(action) {
  const {
    words,
    passphrase,
    pin,
    password,
    routerHistory,
    fromXpriv,
    xpub,
  } = action.payload;

  yield put(loadingAddresses(true));
  yield put(storeRouterHistory(routerHistory));

  // When we start a wallet from the locked screen, we need to unlock it in the storage
  oldWalletUtil.unlock();

  const network = config.getNetwork();
  const registeredTokens = tokensUtils.getTokens();

  // Before cleaning loaded data we must save in redux what we have of tokens in localStorage
  yield put(reloadData({ tokens: registeredTokens }));

  // We are offline, the connection object is yet to be created
  yield put(isOnlineUpdate({ isOnline: false }));

  const uniqueDeviceId = walletHelpers.getUniqueId();
  const featureFlags = new FeatureFlags(uniqueDeviceId, network.name);
  const hardwareWallet = oldWalletUtil.isHardwareWallet();

  // For now, the wallet service does not support hardware wallet, so default to the old facade
  const useWalletService = hardwareWallet ? false : yield call(() => featureFlags.shouldUseWalletService());

  yield put(setUseWalletService(useWalletService));

  // This is a work-around so we can dispatch actions from inside callbacks.
  let dispatch;
  yield put((_dispatch) => {
    dispatch = _dispatch;
  });

  // If we've lost redux data, we could not properly stop the wallet object
  // then we don't know if we've cleaned up the wallet data in the storage
  // If it's fromXpriv, then we can't clean access data because we need that
  oldWalletUtil.cleanLoadedData({ cleanAccessData: !fromXpriv });

  let wallet, connection;
  if (useWalletService) {
    let xpriv = null;

    if (fromXpriv) {
      xpriv = oldWalletUtil.getAcctPathXprivKey(pin);
    }

    const {
      walletServiceBaseUrl,
      walletServiceWsUrl,
    } = HathorWalletServiceWallet.getServerUrlsFromStorage();

    // Set urls for wallet service. If we have it on storage, use it, otherwise use defaults
    config.setWalletServiceBaseUrl(walletServiceBaseUrl || WALLET_SERVICE_MAINNET_BASE_URL);
    config.setWalletServiceBaseWsUrl(walletServiceWsUrl || WALLET_SERVICE_MAINNET_BASE_WS_URL);

    const walletConfig = {
      seed: words,
      xpriv,
      xpub,
      requestPassword: async () => new Promise((resolve) => {
        /**
         * Lock screen will call `resolve` with the pin screen after validation
         */
        routerHistory.push('/locked/');
        dispatch(lockWalletForResult(resolve));
      }),
      passphrase,
      network,
    };

    wallet = new HathorWalletServiceWallet(walletConfig);
    connection = wallet.conn;
  } else {
    let xpriv = null;

    if (fromXpriv) {
      xpriv = oldWalletUtil.getXprivKey(pin);
    }

    connection = new Connection({
      network: network.name,
      servers: [helpers.getServerURL()],
    });

    const beforeReloadCallback = () => {
      dispatch(reloadingWallet());
    };

    const walletConfig = {
      seed: words,
      xpriv,
      xpub,
      store: STORE,
      passphrase,
      connection,
      beforeReloadCallback,
    };

    wallet = new HathorWallet(walletConfig);
  }

  yield put(setWallet(wallet));

  // Setup listeners before starting the wallet so we don't lose messages
  const walletListenerThread = yield fork(setupWalletListeners, wallet);

  // Create a channel to listen for the ready state and
  // wait until the wallet is ready
  const walletReadyThread = yield fork(listenForWalletReady, wallet);

  // Thread to listen for feature flags from Unleash
  const featureFlagsThread = yield fork(listenForFeatureFlags, featureFlags);

  // Keep track of the forked threads so we can cancel them later. We are currently
  // using this to start the startWallet saga again during a reload
  const threads = [
    walletListenerThread,
    walletReadyThread,
    featureFlagsThread
  ];

  try {
    const serverInfo = yield call(wallet.start.bind(wallet), {
      pinCode: pin,
      password,
    });

    let version;
    let networkName = network.name;

    if (serverInfo) {
      version = serverInfo.version;
      networkName = serverInfo.network;
    }

    yield put(setServerInfo({
      version,
      network: networkName,
    }));
  } catch(e) {
    if (useWalletService) {
      // Wallet Service start wallet will fail if the status returned from
      // the service is 'error' or if the start wallet request failed.
      // We should fallback to the old facade by storing the flag to ignore
      // the feature flag
      yield call(featureFlags.ignoreWalletServiceFlag.bind(featureFlags));

      // Cleanup all listeners
      yield cancel(threads);

      // Yield the same action so it will now load on the old facade
      yield put(action);

      // takeLatest will stop running the generator if a new START_WALLET_REQUESTED
      // action is dispatched, but returning so the code is clearer
      return;
    }
  }

  // Wallet start called, we need to show the loading addresses screen
  routerHistory.replace('/loading_addresses');

  // Wallet might be already ready at this point
  if (!wallet.isReady()) {
    const { error } = yield race({
      success: take(types.WALLET_STATE_READY),
      error: take(types.WALLET_STATE_ERROR),
    });

    if (error) {
      yield put(startWalletFailed());
      yield cancel(threads);
      return;
    }
  }

  try {
    const { allTokens } = yield call(loadTokens);
    // Store all tokens on redux
    yield put(loadWalletSuccess(allTokens));
  } catch(e) {
    yield put(startWalletFailed());
    yield cancel(threads);
    return;
  }

  routerHistory.replace('/wallet/');

  yield put(loadingAddresses(false));

  // The way the redux-saga fork model works is that if a saga has `forked`
  // another saga (using the `fork` effect), it will remain active until all
  // the forks are terminated. You can read more details at
  // https://redux-saga.js.org/docs/advanced/ForkModel
  // So, if a new START_WALLET_REQUESTED action is dispatched or a RELOAD_WALLET_REQUESTED
  // is dispatched, we need to cleanup all attached forks (that will cause the event
  // listeners to be cleaned).
  const { reload } = yield race({
    start: take(types.START_WALLET_REQUESTED),
    reload: take(types.RELOAD_WALLET_REQUESTED),
  });

  // We need to cancel threads on both reload and start
  yield cancel(threads);

  if (reload) {
    // Yield the same action again to reload the wallet
    yield put(action);
  }
}

/**
 * This saga will load HTR history and balance and dispatch actions
 * to asynchronously load all registered tokens
 */
export function* loadTokens() {
  const htrUid = hathorLibConstants.HATHOR_TOKEN_CONFIG.uid;

  yield call(fetchTokenData, htrUid);
  const wallet = yield select((state) => state.wallet);

  // Fetch all tokens, including the ones that are not registered yet
  const allTokens = yield call(wallet.getTokens.bind(wallet));
  const registeredTokens = tokensUtils
    .getTokens()
    .reduce((acc, token) => {
      // remove htr since we will always download the HTR token
      if (token.uid === htrUid) {
        return acc;
      }

      return [...acc, token.uid];
    }, []);

  // We don't need to wait for the metadatas response, so we can just
  // spawn a new "thread" to handle it.
  //
  // `spawn` is similar to `fork`, but it creates a `detached` fork
  yield spawn(fetchTokensMetadata, registeredTokens);

  // Dispatch actions to asynchronously load the balances of each token the wallet has
  // ever interacted with. The `put` effect will just dispatch and continue, loading
  // the tokens asynchronously.
  //
  // Note: We need to download the balance of all the tokens from the wallet so we can
  // hide zero-balance tokens
  for (const token of allTokens) {
    yield put(tokenFetchBalanceRequested(token));
  }

  return { allTokens, registeredTokens };
}

/**
 * The wallet needs each token metadata to show information correctly
 * So we fetch the tokens metadata and store on redux
 */
export function* fetchTokensMetadata(tokens) {
  // No tokens to load
  if (!tokens.length) {
    yield put(metadataLoaded(true));
    return;
  }

  yield put(metadataLoaded(false));

  for (const token of tokens) {
    yield put({
      type: types.TOKEN_FETCH_METADATA_REQUESTED,
      tokenId: token,
    });
  }

  const responses = yield all(
    tokens.map((token) => take(
      specificTypeAndPayload([
        types.TOKEN_FETCH_METADATA_SUCCESS,
        types.TOKEN_FETCH_METADATA_FAILED,
      ], {
        tokenId: token,
      }),
    ))
  );

  const tokenMetadatas = {};
  const errors = [];

  for (const response of responses) {
    if (response.type === types.TOKEN_FETCH_METADATA_FAILED) {
      errors.push(response.tokenId);
    } else if (response.type === types.TOKEN_FETCH_METADATA_SUCCESS) {
      // When the request returns null, it means that we have no metadata for this token
      if (response.data) {
        tokenMetadatas[response.tokenId] = response.data;
      }
    }
  }

  yield put(tokenMetadataUpdated(tokenMetadatas, errors));
}

// This will create a channel to listen for featureFlag updates
export function* listenForFeatureFlags(featureFlags) {
  const channel = eventChannel((emitter) => {
    const listener = (state) => emitter(state);
    featureFlags.on(FeatureFlagEvents.WALLET_SERVICE_ENABLED, (state) => {
      emitter(state);
    });

    // Cleanup when the channel is closed
    return () => {
      featureFlags.removeListener('wallet-service-enabled', listener);
    };
  });

  try {
    while (true) {
      const newUseWalletService = yield take(channel);
      const oldUseWalletService = yield select((state) => state.useWalletService);

      if (oldUseWalletService && oldUseWalletService !== newUseWalletService) {
        yield put(reloadWalletRequested());
      }
    }
  } finally {
    if (yield cancelled()) {
      // When we close the channel, it will remove the event listener
      channel.close();
    }
  }
}

// This will create a channel from an EventEmitter to wait until the wallet is loaded,
// dispatching actions
export function* listenForWalletReady(wallet) {
  const channel = eventChannel((emitter) => {
    const listener = (state) => emitter(state);
    wallet.on('state', (state) => emitter(state));

    // Cleanup when the channel is closed
    return () => {
      wallet.removeListener('state', listener);
    };
  });

  try {
    while (true) {
      const message = yield take(channel);

      if (message === HathorWallet.ERROR) {
        yield put(walletStateError());
        yield cancel();
      } else {
        if (wallet.isReady()) {
          yield put(walletStateReady());
          yield cancel();
        }

        continue;
      }
    }
  } finally {
    if (yield cancelled()) {
      // When we close the channel, it will remove the event listener
      channel.close();
    }
  }
}

export function* handleTx(action) {
  const tx = action.payload;
  const wallet = yield select((state) => state.wallet);
  const routerHistory = yield select((state) => state.routerHistory);

  if (!wallet.isReady()) {
    return;
  }

  // find tokens affected by the transaction
  const affectedTokens = new Set();

  for (const output of tx.outputs) {
    affectedTokens.add(output.token);
  }

  for (const input of tx.inputs) {
    affectedTokens.add(input.token);
  }
  const stateTokens = yield select((state) => state.tokens);
  const registeredTokens = stateTokens.map((token) => token.uid);

  let message = '';
  if (helpers.isBlock(tx)) {
    message = 'You\'ve found a new block! Click to open it.';
  } else {
    message = 'You\'ve received a new transaction! Click to open it.'
  }

  const notification = walletUtils.sendNotification(message);

  // Set the notification click, in case we have sent one
  if (notification !== undefined) {
    notification.onclick = () => {
      if (!routerHistory) {
        return;
      }

      routerHistory.push(`/transaction/${tx.tx_id}/`);
    }
  }

  // We should refresh the available addresses.
  // Since we have already received the transaction at this point, the wallet
  // instance will already have updated its current address, we should just
  // fetch it and update the redux-store
  const newAddress = wallet.getCurrentAddress();
  yield put(sharedAddressUpdate({
    lastSharedAddress: newAddress.address,
    lastSharedIndex: newAddress.index,
  }));
  // We should download the **balance** and **history** for every token involved
  // in the transaction
  for (const tokenUid of affectedTokens) {
    if (registeredTokens.indexOf(tokenUid) === -1) {
      continue;
    }

    yield put(tokenFetchBalanceRequested(tokenUid, true));
    yield put(tokenFetchHistoryRequested(tokenUid, true));
  }
}

export function* setupWalletListeners(wallet) {
  const channel = eventChannel((emitter) => {
    const listener = (state) => emitter(state);
    wallet.conn.on('best-block-update', (blockHeight) => emitter({
      type: 'WALLET_BEST_BLOCK_UPDATE',
      data: blockHeight,
    }));
    wallet.conn.on('wallet-load-partial-update', (data) => emitter({
      type: 'WALLET_PARTIAL_UPDATE',
      data,
    }));
    wallet.conn.on('state', (state) => emitter({
      type: 'WALLET_CONN_STATE_UPDATE',
      data: state,
    }));
    wallet.on('reload-data', () => emitter({
      type: 'WALLET_RELOAD_DATA',
    }));
    wallet.on('update-tx', (data) => emitter({
      type: 'WALLET_UPDATE_TX',
      data,
    }));
    wallet.on('new-tx', (data) => emitter({
      type: 'WALLET_NEW_TX',
      data,
    }));

    return () => {
      wallet.conn.removeListener('best-block-update', listener);
      wallet.conn.removeListener('wallet-load-partial-update', listener);
      wallet.conn.removeListener('state', listener);
      wallet.removeListener('reload-data', listener);
      wallet.removeListener('update-tx', listener);
      wallet.removeListener('new-tx', listener);
    };
  });

  try {
    while (true) {
      const message = yield take(channel);

      yield put({
        type: message.type,
        payload: message.data,
      });
    }
  } finally {
    if (yield cancelled()) {
      // When we close the channel, it will remove the event listener
      channel.close();
    }
  }
}

export function* loadPartialUpdate({ payload }) {
  const transactions = Object.keys(payload.historyTransactions).length;
  const addresses = payload.addressesFound;
  yield put(updateLoadedData({ transactions, addresses }));
}

export function* bestBlockUpdate({ payload }) {
  const currentHeight = yield select((state) => state.height);
  const wallet = yield select((state) => state.wallet);

  if (!wallet.isReady()) {
    return;
  }

  if (currentHeight !== payload) {
    yield put(tokenFetchBalanceRequested(hathorLibConstants.HATHOR_TOKEN_CONFIG.uid));
  }
}

export function* onWalletConnStateUpdate({ payload }) {
  const isOnline = payload === Connection.CONNECTED;

  yield put(isOnlineUpdate({ isOnline }));
}

export function* walletReloading() {
  yield put(loadingAddresses(true));

  const wallet = yield select((state) => state.wallet);
  const useWalletService = yield select((state) => state.useWalletService);
  const routerHistory = yield select((state) => state.routerHistory);

  // If we are using the wallet-service, we don't need to wait until the addresses
  // are reloaded since they are stored on the wallet-service itself.
  if (!useWalletService) {
    // Since we close the channel after a walletReady event is received,
    // we must fork this saga again so we setup listeners again.
    yield fork(listenForWalletReady, wallet);

    // Wait until the wallet is ready
    yield take(types.WALLET_STATE_READY);
  }

  try {
    // Store all tokens on redux as we might have lost tokens during the disconnected
    // period.
    const { allTokens } = yield call(loadTokens);

    // We might have lost transactions during the reload, so we must invalidate the
    // token histories:
    for (const tokenUid of allTokens) {
      if (tokenUid === hathorLibConstants.HATHOR_TOKEN_CONFIG.uid) {
        continue;
      }
      yield put(tokenInvalidateHistory(tokenUid));
    }

    // If we are on the wallet-service, we also need to refresh the
    // facade instance internal addresses
    if (useWalletService) {
      yield call(wallet.getNewAddresses.bind(wallet));
    }

    // dispatch the refreshSharedAddress so our redux store is potentially
    // updated with the new addresses that we missed during the disconnection
    // time
    yield put(walletRefreshSharedAddress());

    // Load success, we can send the user back to the wallet screen
    yield put(loadWalletSuccess(allTokens));
    routerHistory.replace('/wallet/');
    yield put(loadingAddresses(false));
  } catch (e) {
    yield put(startWalletFailed());
    return;
  }
}

export function* refreshSharedAddress() {
  const wallet = yield select((state) => state.wallet);

  const { address, index } = wallet.getCurrentAddress();

  yield put(sharedAddressUpdate({
    lastSharedAddress: address,
    lastSharedIndex: index,
  }));
}

export function* saga() {
  yield all([
    takeLatest(types.START_WALLET_REQUESTED, errorHandler(startWallet, startWalletFailed())),
    takeLatest('WALLET_CONN_STATE_UPDATE', onWalletConnStateUpdate),
    takeLatest('WALLET_RELOADING', walletReloading),
    takeEvery('WALLET_NEW_TX', handleTx),
    takeEvery('WALLET_UPDATE_TX', handleTx),
    takeEvery('WALLET_BEST_BLOCK_UPDATE', bestBlockUpdate),
    takeEvery('WALLET_PARTIAL_UPDATE', loadPartialUpdate),
    takeEvery('WALLET_RELOAD_DATA', walletReloading),
    takeEvery('WALLET_REFRESH_SHARED_ADDRESS', refreshSharedAddress),
  ]);
}
