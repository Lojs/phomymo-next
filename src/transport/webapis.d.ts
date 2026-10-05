// Web Bluetooth and WebUSB are not part of lib.dom, so their ambient declarations come from
// @types/web-bluetooth and @types/w3c-web-usb, which tsconfig.json's `types` allowlist now names
// (it is an explicit list, so installing a @types package is not enough on its own).
//
// This file used to declare `navigator.bluetooth: any` and `navigator.usb: any`, which meant every
// BluetoothDevice, RemoteGATTCharacteristic and USBDevice in the transports was unchecked: a
// renamed or misspelled property compiled fine and failed at the printer. With the real types, the
// transports are typed at the boundary; anything genuinely outside the spec is cast at its call site.
export {};