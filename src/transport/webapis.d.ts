// Web Bluetooth / WebUSB are not part of lib.dom; the transports use them loosely.
interface Navigator {
  bluetooth: any;
  usb: any;
}
