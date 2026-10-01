export const BLE = {
  SERVICE_UUID: 0xff00,
  WRITE_CHAR_UUID: 0xff02,
  NOTIFY_CHAR_UUID: 0xff03,
  /** Alternative services used by other printer families (PM-241, etc.). */
  ALT_SERVICE_UUIDS: [
    0xff00,
    0xffe0,
    0xae30,
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb',
  ] as (number | string)[],
  CHUNK_SIZE: 128,
  CHUNK_DELAY_MS: 20,
  MAX_RETRIES: 1,
  INITIAL_RETRY_DELAY_MS: 300,
};
