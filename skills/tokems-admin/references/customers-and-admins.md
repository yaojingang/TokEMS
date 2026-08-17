# Customers and Administrators

Customer lists stay masked. Resolve one customer by public ID or an explicitly supplied identifier before sensitive reads or writes. Profile, tags, status, sessions, registrations, and invoices use field allow-lists. Permanent deletion is critical.

Administrator creation, removal, role, grants, and credentials are critical and retain existing TokEMS super-administrator protections. The delegated administrator cannot edit its own credentials, expand connection scopes, approve another Agent connection, or approve its own remote operation through an Agent token.

One-time passwords and reset material use the protected terminal or browser handoff and never enter model output.
