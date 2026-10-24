Final small safety revision in the SAME Studio workspace. Current provided main.js, wallet.js and package.json are exact local updates to your last revision. Adopt these round-trip files and run compile, npm test, npm run build, then refresh the running Studio preview. Keep the same vanilla app entry and do not revive the old React UI.

Changes made locally after your prior review:
- Persist the complete payment intent BEFORE requesting a wallet transaction, so a wallet/RPC error without a hash cannot lose the reference and allow a duplicate payment. Only an explicit user rejection removes an unbroadcast intent. An ambiguous result stays pending and blocks a new payment.
- Record the starting block and allow read-only lookup of the indexed SplitPaid event to find a payment whose wallet response omitted a hash. Only verify a successful matching receipt before showing paid.
- Keep pending entries when pruning browser-local history. Show a status-check button even when the hash is missing.
- Preserve your mode-change dialog-close fix.
- Apply compatible dependency overrides: abitype's optional zod peer to 4.6.6 and solc's tmp to 0.2.7. Hardhat remains on its compatible Zod 3 internally; do not force Hardhat to use Zod 4. Keep npm's local tool audit limitations documented.

Please review these changes for genuine defects. Do not perform real wallet, deployment or funding actions. No mainnet or testnet transactions, grant submissions, social posts or paid purchases. Report exact validation results, the current preview URL, and any defect fixed. Confirm the frontend still builds and serves. This remains local preparation plus substantive Studio development; do not claim all original code was created from scratch in Studio.
