import type { EventId } from '@conference/contracts';

type CheckInStorageItem = 'offlineQueue' | 'batchKey' | 'deviceCode' | 'deviceToken' | 'device';

interface RemovableStorage {
  removeItem(key: string): unknown;
}

const legacyKeys: CheckInStorageItem[] = [
  'offlineQueue',
  'batchKey',
  'deviceCode',
  'deviceToken',
  'device',
];

export function checkInStorageKey(eventId: EventId, item: CheckInStorageItem) {
  return `conference.checkin.${eventId}.${item}`;
}

export function clearLegacyCheckInStorage(storage: RemovableStorage) {
  for (const item of legacyKeys) storage.removeItem(`conference.checkin.${item}`);
}
