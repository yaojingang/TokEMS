type LegacyCheckInStorageItem =
  | 'offlineQueue'
  | 'batchKey'
  | 'deviceCode'
  | 'deviceToken'
  | 'device';

interface RemovableStorage {
  removeItem(key: string): unknown;
}

const legacyKeys: LegacyCheckInStorageItem[] = [
  'offlineQueue',
  'batchKey',
  'deviceCode',
  'deviceToken',
  'device',
];

export function clearLegacyCheckInStorage(storage: RemovableStorage) {
  for (const item of legacyKeys) storage.removeItem(`conference.checkin.${item}`);
}
