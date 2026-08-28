# TokEMS Admin executable checks

Run the connector and template patch checks from the repository root:

```bash
pnpm test:tokems-admin-skill
```

The suite covers catalog pinning, protected reads and exports, attendee-question input guards, artifact permissions, live-revision template patching, field preservation, key deletion, complete ordering, FAQ updates, invalid node rejection, and unsafe object-key rejection.

Runtime catalog-to-handler mapping, exact handler grants, attendee-question verification targeting, and generated contract drift are checked by the API and repository scripts:

```bash
pnpm skill:tokems-contracts:check
pnpm --filter @conference/api test
```
