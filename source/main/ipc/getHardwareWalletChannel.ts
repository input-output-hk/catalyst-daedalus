import { BrowserWindow } from 'electron';
import TransportNodeHid, {
  getDevices,
} from '@ledgerhq/hw-transport-node-hid-noevents';
import AppAda, { utils } from '@cardano-foundation/ledgerjs-hw-app-cardano';
import TrezorConnect, {
  DEVICE,
  DEVICE_EVENT,
  TRANSPORT,
  TRANSPORT_EVENT,
  UI,
  UI_EVENT, // @ts-ignore
} from 'trezor-connect';
import { find, get, includes, last, omit } from 'lodash';
import { derivePublic as deriveChildXpub } from 'cardano-crypto.js';
import {
  deviceDetection,
  waitForDevice,
} from './hardwareWallets/ledger/deviceDetection';
import { IpcSender } from '../../common/ipc/lib/IpcChannel';
import { logger } from '../utils/logging';
import {
  HardwareWalletTransportDeviceRequest,
  TransportDevice,
} from '../../common/types/hardware-wallets.types';

import { HardwareWalletChannels } from './createHardwareWalletIPCChannels';
import { Device } from './hardwareWallets/ledger/deviceDetection/types';
import { DeviceDetectionPayload } from './hardwareWallets/ledger/deviceDetection/deviceDetection';

type ListenerType = {
  unsubscribe: (...args: Array<any>) => any;
};
type ledgerStatusType = {
  listening: boolean;
  Listener: ListenerType | null;
};
export const ledgerStatus: ledgerStatusType = {
  listening: false,
  Listener: null,
};
let devicesMemo = {};

class EventObserver {
  mainWindow: IpcSender;
  getHardwareWalletConnectionChannel: HardwareWalletChannels['getHardwareWalletConnectionChannel'];

  constructor({
    mainWindow,
    getHardwareWalletConnectionChannel,
  }: {
    mainWindow: IpcSender;
    getHardwareWalletConnectionChannel: HardwareWalletChannels['getHardwareWalletConnectionChannel'];
  }) {
    this.mainWindow = mainWindow;
    this.getHardwareWalletConnectionChannel =
      getHardwareWalletConnectionChannel;
  }

  next = async (event: DeviceDetectionPayload) => {
    try {
      const transportList = await TransportNodeHid.list();
      const connectionChanged = event.type === 'add' || event.type === 'remove';
      logger.info(
        `[HW-DEBUG] Ledger NEXT: , ${JSON.stringify({
          event,
          transportList,
          connectionChanged,
        })}`
      );

      if (connectionChanged) {
        logger.info('[HW-DEBUG] Ledger NEXT - connection changed');
        const { device, deviceModel } = event;

        if (event.type === 'add') {
          if (!devicesMemo[device.path]) {
            logger.info('[HW-DEBUG] CONSTRUCTOR ADD');

            try {
              const transport = await TransportNodeHid.open(device.path);
              const AdaConnection = new AppAda(transport);
              devicesMemo[device.path] = {
                device,
                transport,
                AdaConnection,
              };
              this.getHardwareWalletConnectionChannel.send(
                {
                  disconnected: false,
                  deviceType: 'ledger',
                  deviceId: null,
                  // Available only when Cardano APP opened
                  deviceModel: deviceModel.id,
                  // e.g. nanoS
                  deviceName: deviceModel.productName,
                  // e.g. Test Name
                  path: device.path,
                  product: device.product,
                },
                this.mainWindow
              );
            } catch (e) {
              logger.info('[HW-DEBUG] CONSTRUCTOR error');
            }
          }
        } else {
          logger.info('[HW-DEBUG] CONSTRUCTOR REMOVE');
          devicesMemo = omit(devicesMemo, [device.path]);

          this.getHardwareWalletConnectionChannel.send(
            {
              disconnected: true,
              deviceType: 'ledger',
              deviceId: null,
              // Available only when Cardano APP opened
              deviceModel: deviceModel.id,
              // e.g. nanoS
              deviceName: deviceModel.productName,
              // e.g. Test Name
              path: device.path,
              product: device.product,
            },
            this.mainWindow
          );
        }

        logger.info('[HW-DEBUG] CONSTRUCTOR Memo');
      } else {
        logger.info('[HW-DEBUG] Ledger NEXT - connection NOT changed');
      }
    } catch (error) {
      logger.error(`[HW-DEBUG] Error on NEXT ${JSON.stringify(error)}`);
    }
  };

  error(e) {
    logger.info('[HW-DEBUG] Ledger NEXT error');
    throw e;
  }

  complete() {
    logger.info('[HW-DEBUG] Ledger NEXT complete');
  }
}

export const handleHardwareWalletRequests = async (
  mainWindow: BrowserWindow,
  {
    getHardwareWalletTransportChannel,
    getExtendedPublicKeyChannel,
    getCardanoAdaAppChannel,
    getHardwareWalletConnectionChannel,
    signTransactionLedgerChannel,
    signTransactionTrezorChannel,
    resetTrezorActionChannel,
    handleInitTrezorConnectChannel,
    handleInitLedgerConnectChannel,
    deriveXpubChannel,
    deriveAddressChannel,
    showAddressChannel,
    waitForLedgerDevicesToConnectChannel,
  }: HardwareWalletChannels
) => {
  let deviceConnection = null;
  let observer;

  const resetTrezorListeners = () => {
    // Remove all listeners if exist - e.g. on app refresh
    TrezorConnect.removeAllListeners();
    // Initialize new device listeners
    TrezorConnect.on(UI_EVENT, (event) => {
      if (event.type === UI.REQUEST_PASSPHRASE) {
        // ui-request_passphrase
        if (event.payload && event.payload.device) {
          TrezorConnect.uiResponse({
            type: UI.RECEIVE_PASSPHRASE,
            // @ts-ignore ts-migrate(2322) FIXME: Type '{ value: string; passphraseOnDevice: true; }... Remove this comment to see the full error message
            payload: {
              value: '',
              passphraseOnDevice: true,
            },
          });
        }
      }
    });
    TrezorConnect.on(TRANSPORT_EVENT, (event) => {
      if (event.type === TRANSPORT.ERROR) {
        // Send Transport error to Renderer
        getHardwareWalletConnectionChannel.send(
          {
            deviceType: 'trezor',
            error: {
              payload: event.payload,
            },
          }, // @ts-ignore
          mainWindow
        );
      }
    });
    TrezorConnect.on(DEVICE_EVENT, (event) => {
      const connectionChanged =
        event.type === DEVICE.CONNECT ||
        event.type === DEVICE.DISCONNECT ||
        event.type === DEVICE.CHANGED;
      const isAcquired = get(event, ['payload', 'type'], '') === 'acquired';
      const deviceError = get(event, ['payload', 'error']);

      if (deviceError) {
        throw new Error(deviceError);
      }

      if (connectionChanged && isAcquired) {
        getHardwareWalletConnectionChannel.send(
          {
            disconnected: event.type === DEVICE.DISCONNECT,
            deviceType: 'trezor',
            deviceId: event.payload.id,
            // 123456ABCDEF
            deviceModel: event.payload.features.model,
            // e.g. T
            deviceName: event.payload.label,
            // e.g. Test Name
            path: event.payload.path,
            eventType: event.type,
          }, // @ts-ignore
          mainWindow
        );
      }
    });
  };

  waitForLedgerDevicesToConnectChannel.onRequest(async () => {
    logger.info('[HW-DEBUG] waitForLedgerDevicesToConnectChannel::waiting');
    const { device, deviceModel } = await waitForDevice();
    logger.info('[HW-DEBUG] waitForLedgerDevicesToConnectChannel::found');
    return {
      disconnected: false,
      deviceType: 'ledger',
      deviceId: null,
      // Available only when Cardano APP opened
      deviceModel: deviceModel.id,
      // e.g. nanoS
      deviceName: deviceModel.productName,
      // e.g. Test Name
      path: device.path,
      product: device.product,
    };
  });

  getHardwareWalletTransportChannel.onRequest(
    async (request: HardwareWalletTransportDeviceRequest) => {
      const { isTrezor, devicePath } = request;
      // @ts-ignore ts-migrate(2345) FIXME: Argument of type 'string' is not assignable to par... Remove this comment to see the full error message
      logger.info('[HW-DEBUG] getHardwareWalletTransportChannel', devicePath);
      // Connected Trezor device info
      let deviceFeatures;

      if (isTrezor) {
        // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
        logger.info('[HW-DEBUG] getHardwareWalletTransportChannel::TREZOR ');

        try {
          deviceFeatures = await TrezorConnect.getFeatures({
            device: {
              path: devicePath,
            },
          });
          // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
          logger.info('[HW-DEBUG] Trezor connect success');

          if (deviceFeatures && deviceFeatures.success) {
            const {
              major_version: majorVersion,
              minor_version: minorVersion,
              patch_version: patchVersion,
              device_id: deviceId,
              model,
              label,
            } = deviceFeatures.payload;
            const firmwareVersion = `${majorVersion}.${minorVersion}.${patchVersion}`;
            return Promise.resolve({
              deviceId,
              deviceType: 'trezor',
              deviceModel: model,
              // e.g. "1" or "T"
              deviceName: label,
              path: devicePath,
              firmwareVersion,
            } as TransportDevice);
          }

          throw deviceFeatures.payload; // Error is in payload
        } catch (e) {
          // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
          logger.info('[HW-DEBUG] Trezor connect error');
          throw e;
        }
      }

      try {
        // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
        logger.info('[HW-DEBUG] getHardwareWalletTransportChannel:: LEDGER');
        const transportList = await TransportNodeHid.list();
        let hw;
        let lastConnectedPath;
        // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
        logger.info(
          `[HW-DEBUG] getHardwareWalletTransportChannel::transportList=${JSON.stringify(
            transportList
          )}`
        );

        const openTransportLayer = async (
          pathToOpen: string,
          device: Device
        ) => {
          if (devicesMemo[pathToOpen]) {
            logger.info('[HW-DEBUG] CLOSING EXISTING TRANSPORT');
            await devicesMemo[pathToOpen].transport.close();
          }
          const transport = await TransportNodeHid.open(pathToOpen);
          hw = transport;
          lastConnectedPath = pathToOpen;

          logger.info('[HW-DEBUG] INIT NEW transport - DONE');

          deviceConnection = new AppAda(transport);
          devicesMemo[lastConnectedPath] = {
            device,
            transport: hw,
            AdaConnection: deviceConnection,
          };
        };

        // @ts-ignore
        if (transportList && !transportList.length) {
          // Establish connection with last device
          try {
            // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
            logger.info('[HW-DEBUG] INIT NEW transport');

            const { device } = await waitForDevice();

            await openTransportLayer(device.path, device);
          } catch (e) {
            // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
            logger.info('[HW-DEBUG] INIT NEW transport - ERROR');
            throw e;
          }
        } else if (!devicePath || !devicesMemo[devicePath]) {
          // Use first like native usb nodeHID
          // @ts-ignore
          lastConnectedPath = transportList[0]; // eslint-disable-line
          logger.info('[HW-DEBUG] USE First transport', { lastConnectedPath });

          if (devicesMemo[lastConnectedPath]) {
            await openTransportLayer(
              lastConnectedPath,
              devicesMemo[lastConnectedPath].device
            );
          } else {
            throw new Error('Device not connected!');
          }
        } else {
          // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
          logger.info('[HW-DEBUG] USE CURRENT CONNECTION');
          hw = devicesMemo[devicePath].transport;
          deviceConnection = get(devicesMemo, [devicePath, 'AdaConnection']);
        }

        // @ts-ignore
        const { deviceModel } = hw;

        if (deviceModel) {
          const { id, productName } = deviceModel;
          const ledgerData: TransportDevice = {
            deviceId: null,
            // @TODO - to be defined
            deviceType: 'ledger',
            deviceModel: id,
            // e.g. nanoS
            deviceName: productName,
            // e.g. Ledger Nano S
            path: lastConnectedPath || devicePath,
          };

          logger.info(
            '[HW-DEBUG] getHardwareWalletTransportChannel:: LEDGER case RESPONSE',
            { ledgerData }
          );

          return Promise.resolve(ledgerData);
        }

        throw new Error('Missing device info');
      } catch (error) {
        // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
        logger.info('[HW-DEBUG] ERROR on getHardwareWalletTransportChannel');
        throw error;
      }
    }
  );
  handleInitTrezorConnectChannel.onRequest(async () => {
    // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
    logger.info('[HW-DEBUG] INIT TREZOR');
    resetTrezorListeners();
    TrezorConnect.manifest({
      email: 'email@developer.com',
      appUrl: 'http://your.application.com',
    });
    TrezorConnect.init({
      popup: false,
      // render your own UI
      webusb: false,
      // webusb is not supported in electron
      debug: true,
      // see what's going on inside connect
      // lazyLoad: true, // set to "false" (default) if you want to start communication with bridge on application start (and detect connected device right away)
      // set it to "true", then trezor-connect will not be initialized until you call some TrezorConnect.method()
      // this is useful when you don't know if you are dealing with Trezor user
      manifest: {
        email: 'email@developer.com',
        // @TODO
        appUrl: 'http://your.application.com', // @TODO
      },
    })
      .then(() => {})
      .catch((error) => {
        throw error;
      });
  });
  handleInitLedgerConnectChannel.onRequest(async () => {
    logger.info('[HW-DEBUG] INIT LEDGER');
    observer = new EventObserver({
      mainWindow: mainWindow as unknown as IpcSender,
      getHardwareWalletConnectionChannel,
    });

    try {
      logger.info('[HW-DEBUG] OBSERVER INIT');

      const onAdd = (payload) => {
        observer.next(payload);
      };

      const onRemove = (payload) => {
        observer.next(payload);
      };

      deviceDetection(onAdd, onRemove);

      logger.info('[HW-DEBUG] OBSERVER INIT - listener started');
    } catch (e) {
      logger.info('[HW-DEBUG] OBSERVER INIT FAILED');
      ledgerStatus.listening = false;
    }
  });
  deriveXpubChannel.onRequest(async (params) => {
    const { parentXpubHex, lastIndex, derivationScheme } = params;
    const parentXpub = utils.hex_to_buf(parentXpubHex);

    try {
      const xpub = deriveChildXpub(parentXpub, lastIndex, derivationScheme);
      return utils.buf_to_hex(xpub);
    } catch (e) {
      throw e;
    }
  });
  deriveAddressChannel.onRequest(async (params) => {
    const {
      addressType,
      spendingPathStr,
      stakingPathStr,
      devicePath,
      isTrezor,
      networkId,
      protocolMagic,
    } = params;
    const spendingPath = utils.str_to_path(spendingPathStr);
    const stakingPath = stakingPathStr
      ? utils.str_to_path(stakingPathStr)
      : null;

    try {
      deviceConnection = get(devicesMemo, [devicePath, 'AdaConnection']);
      // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
      logger.info('[HW-DEBUG] DERIVE ADDRESS');

      if (isTrezor) {
        const result = await TrezorConnect.cardanoGetAddress({
          device: {
            path: devicePath,
            // @ts-ignore ts-migrate(2769) FIXME: No overload matches this call.
            showOnTrezor: true,
          },
          addressParameters: {
            addressType,
            path: `m/${spendingPathStr}`,
            stakingPath: stakingPathStr ? `m/${stakingPathStr}` : null,
          },
          protocolMagic,
          networkId,
        });
        // @ts-ignore ts-migrate(2339) FIXME: Property 'address' does not exist on type '{ error... Remove this comment to see the full error message
        return result.payload.address;
      }

      // Check if Ledger instantiated
      if (!deviceConnection) {
        throw new Error('Ledger device not connected');
      }

      const { addressHex } = await deviceConnection.deriveAddress({
        network: {
          networkId,
          protocolMagic,
        },
        address: {
          type: addressType,
          params: {
            spendingPath,
            stakingPath,
          },
        },
      });
      const encodedAddress = utils.bech32_encodeAddress(
        utils.hex_to_buf(addressHex)
      );
      return encodedAddress;
    } catch (e) {
      throw e;
    }
  });
  showAddressChannel.onRequest(async (params) => {
    const {
      addressType,
      spendingPathStr,
      stakingPathStr,
      devicePath,
      isTrezor,
      networkId,
      protocolMagic,
    } = params;
    const spendingPath = utils.str_to_path(spendingPathStr);
    const stakingPath = stakingPathStr
      ? utils.str_to_path(stakingPathStr)
      : null;

    try {
      deviceConnection = get(devicesMemo, [devicePath, 'AdaConnection']);
      // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
      logger.info('[HW-DEBUG] SHOW ADDRESS');

      if (isTrezor) {
        throw new Error('Address verification not supported on Trezor devices');
      }

      // Check if Ledger instantiated
      if (!deviceConnection) {
        throw new Error('Ledger device not connected');
      }

      await deviceConnection.showAddress({
        network: {
          networkId,
          protocolMagic,
        },
        address: {
          type: addressType,
          params: {
            spendingPath,
            stakingPath,
          },
        },
      });
      return;
    } catch (e) {
      throw e;
    }
  });
  getCardanoAdaAppChannel.onRequest(async (request) => {
    const { path, product } = request;

    try {
      if (!devicesMemo[path]) {
        const deviceList = getDevices();
        const device =
          find(deviceList, ['product', product]) ||
          find(deviceList, ['path', path]);

        logger.info('[HW-DEBUG] getCardanoAdaAppChannel:: Path not found', {
          product,
          deviceList,
          oldPath: path,
        });

        if (!device) {
          logger.info('[HW-DEBUG] Device not instantiated!', {
            path,
            devicesMemo,
          });
          // eslint-disable-next-line
          throw {
            code: 'DEVICE_NOT_CONNECTED',
          };
        }

        const newTransport = await TransportNodeHid.open(device.path);
        const newDeviceConnection = new AppAda(newTransport);

        logger.info('[HW-DEBUG] getCardanoAdaAppChannel::Use new device path', {
          product,
          device,
          newPath: device.path,
          oldPath: path,
        });

        devicesMemo[device.path] = {
          device,
          transport: newTransport,
          AdaConnection: newDeviceConnection,
        };

        if (device.path !== path) {
          // eslint-disable-next-line
          throw {
            code: 'DEVICE_PATH_CHANGED',
            path: device.path,
          };
        }
      }

      if (!path || !devicesMemo[path]) {
        logger.info('[HW-DEBUG] Device not instantiated!', {
          path,
          devicesMemo,
        });
        // eslint-disable-next-line
        throw {
          code: 'DEVICE_NOT_CONNECTED',
        };
      }

      // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
      logger.info(`[HW-DEBUG] GET CARDANO APP path:${path}`);
      deviceConnection = devicesMemo[path].AdaConnection;
      const { version } = await deviceConnection.getVersion();
      // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
      logger.info('[HW-DEBUG] getCardanoAdaAppChannel:: appVersion');
      const { serialHex } = await deviceConnection.getSerial();
      // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
      logger.info(
        `[HW-DEBUG] getCardanoAdaAppChannel:: deviceSerial: ${serialHex}`
      );
      const { minor, major, patch } = version;
      return Promise.resolve({
        minor,
        major,
        patch,
        deviceId: serialHex,
      });
    } catch (error) {
      const errorCode = error.code || '';
      const errorName = error.name || 'UknownErrorName';
      const errorMessage = error.message || 'UknownErrorMessage';
      const isDeviceDisconnected = errorCode === 'DEVICE_NOT_CONNECTED';
      const isDisconnectError =
        errorName === 'DisconnectedDevice' ||
        errorMessage === 'Cannot write to hid device';
      //  errorMessage.toLowerCase().includes('cannot open device with path') ||
      //  errorMessage.toLowerCase().includes('cannot write to hid device') ||
      //  errorMessage.toLowerCase().includes('cannot write to closed device');
      logger.info('[HW-DEBUG] ERROR in Cardano App', {
        path,
        errorName,
        errorMessage,
        isDisconnectError,
        isDeviceDisconnected,
      });

      if (path && !isDeviceDisconnected && isDisconnectError) {
        // @ts-ignore
        const oldPath = path;
        const deviceMemo = devicesMemo[oldPath];
        const devicePaths = await TransportNodeHid.list();
        const hasPathChanged = !includes(devicePaths, oldPath);
        const newPath = hasPathChanged ? last(devicePaths) : oldPath;

        if (!newPath) {
          logger.info(
            '[HW-DEBUG] ERROR in Cardano App (Device paths list is empty)',
            {
              devicePaths,
              oldPath,
              newPath,
              deviceList: getDevices(),
            }
          );
          // eslint-disable-next-line
          throw {
            code: 'NO_DEVICE_PATHS',
            errorCode,
            errorName,
          };
        }

        const { device: oldDevice } = deviceMemo;
        // @ts-ignore
        const newTransport = await TransportNodeHid.open(newPath);
        const newDeviceConnection = new AppAda(newTransport);
        const deviceList = getDevices();
        const newDevice = find(deviceList, ['path', newPath]);
        const hasDeviceChanged = newDevice.productId !== oldDevice.productId;
        // TODO: remove
        deviceConnection = newDeviceConnection;
        // Purge old device memo
        devicesMemo = omit(devicesMemo, [oldPath]);
        logger.info(
          '[HW-DEBUG] ERROR in Cardano App (Re-establish Connection)',
          {
            hasPathChanged,
            hasDeviceChanged,
            oldPath: oldPath || 'UNKNOWN_PATH',
            newPath: newPath || 'UNKNOWN_PATH',
            oldDevice: oldDevice || 'NOT_FOUND',
            newDevice: newDevice || 'NOT_FOUND',
          }
        );
        // Update devicesMemo
        // @ts-ignore ts-migrate(2538) FIXME: Type 'unknown' cannot be used as an index type.
        devicesMemo[newPath] = {
          device: newDevice,
          transport: newTransport,
          AdaConnection: newDeviceConnection,
        };

        if (hasPathChanged) {
          // eslint-disable-next-line
          throw {
            code: 'DEVICE_PATH_CHANGED',
            path: newPath,
          };
        }
      }

      throw error;
    }
  });
  getExtendedPublicKeyChannel.onRequest(async (params) => {
    // Params example:
    // { path: "1852'/1815'/0'", isTrezor: false, devicePath: null }
    // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
    logger.info('[HW-DEBUG] getExtendedPublicKeyChannel');
    const { path, isTrezor, devicePath } = params;

    try {
      if (isTrezor) {
        // Check if Trezor instantiated
        const deviceFeatures = await TrezorConnect.getFeatures({
          device: {
            path: devicePath,
          },
        });

        if (deviceFeatures.success) {
          const extendedPublicKeyResponse =
            await TrezorConnect.cardanoGetPublicKey({
              path: `m/${path}`,
              showOnTrezor: true,
            });

          if (!extendedPublicKeyResponse.success) {
            throw extendedPublicKeyResponse.payload;
          }

          const extendedPublicKey = get(
            extendedPublicKeyResponse,
            ['payload', 'node'],
            {}
          );
          return Promise.resolve({
            // @ts-ignore ts-migrate(2339) FIXME: Property 'public_key' does not exist on type '{} |... Remove this comment to see the full error message
            publicKeyHex: extendedPublicKey.public_key,
            // @ts-ignore ts-migrate(2339) FIXME: Property 'chain_code' does not exist on type '{} |... Remove this comment to see the full error message
            chainCodeHex: extendedPublicKey.chain_code,
          });
        }

        throw new Error('Trezor device not connected');
      }

      deviceConnection = get(devicesMemo, [devicePath, 'AdaConnection']);
      // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
      logger.info('[HW-DEBUG] EXPORT KEY');

      // Check if Ledger instantiated
      if (!deviceConnection) {
        throw new Error('Ledger device not connected');
      }

      const extendedPublicKey = await deviceConnection.getExtendedPublicKey({
        path: utils.str_to_path(path),
      });
      const deviceSerial = await deviceConnection.getSerial();
      return Promise.resolve({
        publicKeyHex: extendedPublicKey.publicKeyHex,
        chainCodeHex: extendedPublicKey.chainCodeHex,
        deviceId: deviceSerial.serialHex,
      });
    } catch (error) {
      logger.info('[HW-DEBUG] EXPORT KEY ERROR', error);
      throw error;
    }
  });
  // @TODO - validityIntervalStart is not working with Cardano App 2.1.0
  signTransactionLedgerChannel.onRequest(async (params) => {
    const {
      inputs,
      outputs,
      protocolMagic,
      fee,
      ttl,
      networkId,
      certificates,
      withdrawals,
      auxiliaryData,
      devicePath,
      signingMode,
      additionalWitnessPaths,
    } = params;
    // @ts-ignore ts-migrate(2554) FIXME: Expected 2 arguments, but got 1.
    logger.info('[HW-DEBUG] SIGN Ledger transaction');
    deviceConnection = devicePath
      ? devicesMemo[devicePath].AdaConnection
      : null;

    try {
      if (!deviceConnection) {
        throw new Error('Device not connected!');
      }

      const signedTransaction = await deviceConnection.signTransaction({
        signingMode,
        additionalWitnessPaths,
        tx: {
          network: {
            networkId,
            protocolMagic,
          },
          inputs,
          outputs,
          fee,
          ttl,
          certificates,
          withdrawals,
          auxiliaryData,
        },
      });
      return Promise.resolve(signedTransaction);
    } catch (e) {
      throw e;
    }
  });
  // @ts-ignore ts-migrate(2345) FIXME: Argument of type '(params: TrezorSignTransactionRe... Remove this comment to see the full error message
  signTransactionTrezorChannel.onRequest(async (params) => {
    const {
      inputs,
      outputs,
      protocolMagic,
      fee,
      ttl,
      networkId,
      certificates,
      devicePath,
      validityIntervalStartStr,
      withdrawals,
      auxiliaryData,
      signingMode,
    } = params;

    if (!TrezorConnect) {
      throw new Error('Device not connected!');
    }

    try {
      const dataToSign = {
        inputs,
        outputs,
        fee,
        ttl,
        protocolMagic,
        networkId,
        certificates,
        withdrawals,
        validityIntervalStartStr,
        auxiliaryData,
        signingMode,
      };
      // @ts-ignore ts-migrate(2345) FIXME: Argument of type '{ inputs: TrezorSignTransactionI... Remove this comment to see the full error message
      const signedTransaction = await TrezorConnect.cardanoSignTransaction({
        device: {
          path: devicePath,
        },
        ...dataToSign,
      });
      return Promise.resolve(signedTransaction);
    } catch (e) {
      throw e;
    }
  });
  resetTrezorActionChannel.onRequest(async () => {
    TrezorConnect.cancel('Method_Cancel');
  });
};
