import Foundation
import Security

guard CommandLine.arguments.count == 3 else { exit(2) }
let account = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let value = FileHandle.standardInput.readDataToEndOfFile()
guard !value.isEmpty else { exit(2) }

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrAccount as String: account,
  kSecAttrService as String: service,
]
let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
if updated == errSecSuccess { exit(0) }
guard updated == errSecItemNotFound else { exit(1) }

var insert = query
insert[kSecValueData as String] = value
exit(SecItemAdd(insert as CFDictionary, nil) == errSecSuccess ? 0 : 1)
