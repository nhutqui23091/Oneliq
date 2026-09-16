# Oneliq Mainnet Cutover — Hướng dẫn Deploy + Audit (từng bước)

> Đọc file này từ trên xuống, làm theo thứ tự. Mỗi bước ghi rõ **file
> nào đặt ở đâu**, **lệnh gì chạy trong terminal nào**, và **kỳ vọng
> output như nào**. Nếu output khác → dừng lại, xem mục Troubleshooting
> ở cuối trước khi làm tiếp.

**Ví deployer**: bạn đã bridge $35.88 USDC vào `0x3907...f7db` trên Arc
Mainnet. Đó là ví sẽ dùng để deploy 2 contract. Tổng gas ~$0.05 USDC —
thừa thãi.

**OS giả định**: Windows 11 + Git Bash (đã có sẵn với Claude Code). Nếu
bạn dùng WSL2 hoặc Mac/Linux thì lệnh y chang.

---

## 📁 Cấu trúc file cuối cùng bạn sẽ có

Sau khi làm xong PHẦN 1, thư mục `C:\arc-swap-v9\contracts` sẽ như này:

```
contracts/
├── AUDIT-GUIDE.md              (đã có — không đụng)
├── DEPLOY-MAINNET.md           (đã có — không đụng)
├── DEPLOY-V2.md                (đã có — testnet only, tham khảo)
├── DEPLOY.md                   (đã có — V1 legacy)
├── WALKTHROUGH.md              (file này)
├── OneliqCheckIn.sol           (đã có)
├── OneliqRouter.sol            (đã có — mainnet Uniswap v4 wrapper mới)
├── OneliqRouterV2.sol          (đã có — testnet Curve wrapper)
├── test/                       (đã có)
│
├── foundry.toml                ← BẠN TẠO Ở PHẦN 1
├── src/                        ← BẠN TẠO Ở PHẦN 1
│   ├── OneliqRouter.sol       (copy từ ../OneliqRouter.sol)
│   └── OneliqCheckIn.sol      (copy từ ../OneliqCheckIn.sol)
├── lib/                        ← Foundry tự tạo
├── out/                        ← Foundry tự tạo (bytecode + ABI)
├── cache/                      ← Foundry tự tạo
├── broadcast/                  ← Foundry tự lưu deploy tx history
├── .env                        ← BẠN TẠO Ở PHẦN 2 (đừng commit!)
└── .gitignore                  ← BẠN TẠO Ở PHẦN 1
```

---

# PHẦN 0 — Cài đặt Foundry (một lần, ~5 phút)

## 0.1. Mở Git Bash

Windows → Start menu → "Git Bash" → Enter.

## 0.2. Cài Foundry

Paste nguyên khối này vào Git Bash và Enter:

```bash
curl -L https://foundry.paradigm.xyz | bash
```

Bạn sẽ thấy:
```
Installing foundryup...
foundryup: installed successfully.
Detected shell: bash
Added foundryup to PATH...
```

**Đóng Git Bash và mở lại** (để PATH refresh). Rồi chạy:

```bash
foundryup
```

Foundryup sẽ tải `forge`, `cast`, `anvil`, `chisel`. Mất ~2 phút. Kết thúc bằng:
```
foundryup: successfully installed nightly (forge, cast, anvil, chisel).
```

## 0.3. Verify đã cài đúng

```bash
forge --version
cast --version
```

Kỳ vọng: cả hai in ra version. Nếu "command not found" → đóng terminal, mở lại.

---

# PHẦN 1 — Setup thư mục contract (~3 phút)

## 1.1. Đi vào thư mục contracts

```bash
cd /c/arc-swap-v9/contracts
```

**Kiểm tra bạn ở đúng chỗ**:
```bash
pwd
```
Phải in ra: `/c/arc-swap-v9/contracts`

## 1.2. Tạo file `foundry.toml`

Trong Git Bash chạy:

```bash
cat > foundry.toml <<'EOF'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200
evm_version = "cancun"

[rpc_endpoints]
arc_mainnet = "https://rpc.mainnet.arc.io"
arc_testnet = "https://rpc.testnet.arc.network"

# Explorer verification — Arc explorer API chưa mở public tại thời điểm
# cutover; bỏ commented khi Circle publish endpoint.
# [etherscan]
# arc_mainnet = { key = "${ARC_EXPLORER_KEY}", url = "https://explorer.arc.io/api" }
EOF
```

Xong. Verify:
```bash
cat foundry.toml
```

## 1.3. Tạo thư mục `src/` và copy contract vào

```bash
mkdir -p src
cp OneliqRouter.sol src/OneliqRouter.sol
cp OneliqCheckIn.sol src/OneliqCheckIn.sol
ls src/
```

Kỳ vọng ls in:
```
OneliqCheckIn.sol  OneliqRouter.sol
```

## 1.4. Tạo `.gitignore` (bảo vệ khỏi commit nhầm private key)

```bash
cat > .gitignore <<'EOF'
# Foundry build artifacts
out/
cache/
broadcast/
lib/

# Secrets — NEVER commit
.env
.env.*
*.key
*.pem
*.keystore
EOF
```

Verify:
```bash
cat .gitignore
```

---

# PHẦN 2 — Setup biến môi trường (~2 phút)

⚠️ **QUAN TRỌNG VỀ PRIVATE KEY**:
- **KHÔNG BAO GIỜ** paste private key vào chat, code, git commit, ảnh chụp màn hình.
- Ví mới bạn tạo cho mainnet nên **CHỈ GIỮ TIỀN VỪA ĐỦ DEPLOY** (~$5 USDC là dư), không phải ví chính chứa tài sản lớn.
- Sau khi deploy xong, ROTATE ownership sang ví khác (dùng `transferOwnership`) nếu bạn muốn giữ deployer key an toàn hơn.

## 2.1. Lấy private key ra khỏi ví

**Cách 1 — MetaMask** (khuyên dùng, an toàn hơn):
- MetaMask → 3 chấm bên account → Account details → Show private key → nhập password
- Copy chuỗi 64 hex (bắt đầu bằng `0x...` hoặc không có `0x`, cả hai đều OK)

**Cách 2 — Ví khác**: mỗi ví có export riêng, Google "export private key <tên ví>"

## 2.2. Tạo file `.env` (KHÔNG COMMIT)

Trong `/c/arc-swap-v9/contracts` chạy:

```bash
cat > .env <<'EOF'
# Deployer private key — file này đã trong .gitignore, KHÔNG commit.
# Dùng ví MỚI chỉ chứa vừa đủ USDC gas, không phải ví chính.
DEPLOYER_PK=0xPASTE_YOUR_PRIVATE_KEY_HERE

# Chain
RPC=https://rpc.mainnet.arc.io

# Owner của contract sau deploy — thường là chính deployer, hoặc EOA khác
OWNER=0xPASTE_YOUR_WALLET_ADDRESS_HERE

# Uniswap v4 Universal Router trên Arc Mainnet (đã verify on-chain)
UNIVERSAL_ROUTER=0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1

# Permit2 (canonical, deployed everywhere)
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3

# Fee: 30 = 0.30%. Hard-capped 100 (=1%) trong contract.
FEE_BPS=30
EOF
```

## 2.3. Edit `.env` với giá trị thật

Mở file bằng editor bất kỳ (nano/vim/VSCode). Vd với nano:

```bash
nano .env
```

Sửa 2 dòng:
- `DEPLOYER_PK=0x...` — paste private key thật (thay `PASTE_YOUR_PRIVATE_KEY_HERE`)
- `OWNER=0x3907...f7db` — địa chỉ ví của bạn

Save: `Ctrl+O`, Enter, `Ctrl+X`.

**Kiểm tra .env KHÔNG bị track bởi git**:
```bash
git -C /c/arc-swap-v9 status --short | grep contracts/.env
```
Nếu output rỗng ← tốt. Nếu có gì ra → `.gitignore` chưa work, fix ngay.

## 2.4. Load .env vào shell

```bash
set -a; source .env; set +a
```

Verify (nên in đúng địa chỉ, KHÔNG in private key):
```bash
echo "OWNER=$OWNER"
echo "RPC=$RPC"
echo "PK length=${#DEPLOYER_PK}"   # nên là 66 (0x + 64 hex) hoặc 64
```

---

# PHẦN 3 — Compile contracts (~1 phút)

```bash
cd /c/arc-swap-v9/contracts
forge build
```

Kỳ vọng output kết thúc bằng:
```
[⠊] Compiling...
[⠆] Compiling 2 files with 0.8.24
[⠰] Solc 0.8.24 finished in ...
Compiler run successful!
```

Nếu có warning về "License identifier not provided" thì bỏ qua. Nếu có
**error đỏ** → xem Troubleshooting.

Verify bytecode được tạo:
```bash
ls out/OneliqRouter.sol/
ls out/OneliqCheckIn.sol/
```

Phải thấy `OneliqRouter.json` và `OneliqCheckIn.json` (ABI + bytecode).

---

# PHẦN 4 — Kiểm tra RPC + balance (~30s)

Trước khi burn USDC deploy, verify RPC + ví hoạt động:

```bash
# Chain ID phải là 0x13b2 = 5042
cast chain-id --rpc-url $RPC

# Balance của deployer bằng USDC (Arc native gas = USDC)
cast balance $OWNER --rpc-url $RPC --ether
```

Kỳ vọng:
- Chain ID: `5042`
- Balance: `35.888...` (35.88 USDC, dưới dạng "ether"-đơn-vị vì Arc coi USDC là native)

Nếu balance = 0 → bạn dùng nhầm ví. Kiểm tra lại `OWNER` trong .env.

---

# PHẦN 5 — Deploy OneliqRouter (~1 phút, gas ~$0.03)

```bash
cd /c/arc-swap-v9/contracts

forge create src/OneliqRouter.sol:OneliqRouter \
  --rpc-url $RPC \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --constructor-args $UNIVERSAL_ROUTER $PERMIT2 $FEE_BPS $OWNER
```

Kỳ vọng output:
```
[⠊] Compiling...
No files changed, compilation skipped
Deployer: 0x3907...f7db
Deployed to: 0xABCDEF...      ← ĐỊA CHỈ MỚI — LƯU LẠI
Transaction hash: 0x123abc...
```

**LƯU địa chỉ này ngay**. Vd:
```bash
echo "ROUTER_ADDR=0xABCDEF..." >> .env
```

## 5.1. Verify constructor args ĐÚNG như bạn muốn

Foundry không check hộ. Đọc back từ chain:

```bash
# Reload .env (vì mới thêm ROUTER_ADDR)
set -a; source .env; set +a

# Đọc từng field
echo "--- OneliqRouter state ---"
echo "UNIVERSAL_ROUTER:"
cast call $ROUTER_ADDR "UNIVERSAL_ROUTER()(address)" --rpc-url $RPC
echo "PERMIT2:"
cast call $ROUTER_ADDR "PERMIT2()(address)" --rpc-url $RPC
echo "owner:"
cast call $ROUTER_ADDR "owner()(address)" --rpc-url $RPC
echo "feeBps:"
cast call $ROUTER_ADDR "feeBps()(uint16)" --rpc-url $RPC
echo "MAX_FEE_BPS:"
cast call $ROUTER_ADDR "MAX_FEE_BPS()(uint16)" --rpc-url $RPC
echo "paused:"
cast call $ROUTER_ADDR "paused()(bool)" --rpc-url $RPC
```

Mọi giá trị PHẢI khớp với `.env`:
- UNIVERSAL_ROUTER = `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1`
- PERMIT2 = `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- owner = địa chỉ ví bạn
- feeBps = 30
- MAX_FEE_BPS = 100
- paused = false

Nếu SAI cái nào → **KHÔNG WIRE VÀO FRONTEND**. Redeploy với args đúng.
Địa chỉ cũ vẫn còn on-chain nhưng không dùng nữa.

---

# PHẦN 6 — Deploy OneliqCheckIn (~30s, gas ~$0.01)

OneliqCheckIn không có constructor args trong source hiện tại. Nếu bạn có
custom args, thêm `--constructor-args ...`.

```bash
forge create src/OneliqCheckIn.sol:OneliqCheckIn \
  --rpc-url $RPC \
  --private-key $DEPLOYER_PK \
  --broadcast
```

Output tương tự:
```
Deployer: 0x3907...f7db
Deployed to: 0xFEDCBA...     ← LƯU LẠI
Transaction hash: 0x...
```

Lưu:
```bash
echo "CHECKIN_ADDR=0xFEDCBA..." >> .env
```

Verify tồn tại on-chain:
```bash
set -a; source .env; set +a
cast code $CHECKIN_ADDR --rpc-url $RPC | head -c 100
```
Phải in ra bytecode (bắt đầu `0x6080...`). Nếu `0x` rỗng → deploy fail.

---

# PHẦN 7 — Audit Tier 0 (Slither + manual review, ~30 phút)

Trước khi wire vào frontend cho user thật xài, chạy static analysis.

## 7.1. Cài Slither

Cần Python 3.8+ đã cài. Verify:
```bash
python3 --version   # phải >= 3.8
pip3 --version
```

Cài Slither:
```bash
pip3 install slither-analyzer
```

Verify:
```bash
slither --version
```

## 7.2. Chạy Slither trên OneliqRouter

```bash
cd /c/arc-swap-v9/contracts
slither src/OneliqRouter.sol \
  --exclude naming-convention,solc-version,pragma \
  --json slither-report-router.json 2>&1 | tee slither-router-output.txt
```

Kết quả sẽ dài. Đọc phần cuối `slither-router-output.txt`:
```
OneliqRouter analyzed (X contracts with Y detectors), Z result(s) found
```

## 7.3. Diễn giải findings

Slither thường flag các mục sau — chúng là **CỐ Ý**, không phải bug:

| Slither finding | Trên OneliqRouter | Đánh giá |
|---|---|---|
| `arbitrary-send-erc20` trên `_pull`/`_push` | recipient luôn là `msg.sender` hoặc `to` do owner truyền | ✅ False positive |
| `reentrancy-events` trên `swap` | `Swap` event emit sau external call, nhưng `nonReentrant` chặn | ✅ False positive |
| `low-level-calls` trong `_pull`/`_push`/`_ensurePermit2Approval` | Dùng `.call()` để tương thích USDT-style tokens | ✅ Cố ý |
| `reentrancy-benign` trên state update sau external call | `_locked` guard đã bảo vệ | ✅ False positive |

**RED FLAGS thật sự** (nếu xuất hiện, dừng và fix):
- `arbitrary-send-eth` — contract này không nên handle ETH
- `unprotected-upgrade` — không có upgrade mechanism
- `tx-origin` — không dùng
- `suicidal` / `selfdestruct` — không có
- `uninitialized-state` — mọi field đã init trong constructor

Nếu Slither surface thứ gì NGOÀI list "cố ý" ở trên, paste output cho tôi
xem trước khi wire.

## 7.4. Chạy Slither trên OneliqCheckIn

```bash
slither src/OneliqCheckIn.sol \
  --exclude naming-convention,solc-version,pragma \
  --json slither-report-checkin.json 2>&1 | tee slither-checkin-output.txt
```

OneliqCheckIn nhỏ hơn nhiều, expect 0-2 findings.

## 7.5. Manual invariant checklist

Đọc `src/OneliqRouter.sol` và tự trả lời (viết ra):

1. **Ai gọi được `withdrawFees` / `pause` / `setFeeBps` / `transferOwnership` / `rescue`?** → Chỉ `owner` (modifier `onlyOwner`)
2. **`rescue` có drain accrued fees được không?** → Không, guard `bal - accrued < amount` chặn
3. **Reentrancy?** → `nonReentrant` trên swap + rescue + withdrawFees
4. **feeBps set > 1% được không?** → Không, check `newBps <= MAX_FEE_BPS` (=100)
5. **Output có thể gửi cho ai ngoài `msg.sender`?** → Không, `_push(tokenOut, msg.sender, ...)` hardcoded
6. **Universal Router bị compromise thì sao?** → Permit2 allowance chỉ `netIn` scoped tới deadline, không phải MAX

Nếu bạn không hiểu điểm nào → hỏi tôi, đừng đoán.

## 7.6. Mythril (optional, deeper, ~5-10 phút)

```bash
pip3 install mythril
myth analyze src/OneliqRouter.sol --solv 0.8.24 --execution-timeout 300
```

Kỳ vọng: `The analysis was completed successfully. No issues were detected.`

---

# PHẦN 8 — Wire địa chỉ vào frontend (~2 phút)

Về lại thư mục project root:

```bash
cd /c/arc-swap-v9
```

## 8.1. Edit `assets/arc-core-v2.js`

Mở file, tìm block này (khoảng dòng 220):

```js
      contracts: {
        // OneliqRouter mainnet — set after deploy. Trade tab falls back to
        // Uniswap v4 Universal Router direct call when router is null.
        router:              null,
        // Uniswap v4 official Arc mainnet deployment
        uniV4PoolManager:    '0x8366a39CC670B4001A1121B8F6A443A643e40951',
        ...
        // OneliqCheckIn mainnet — set after deploy; Portal streak fallback
        // to localStorage-only when null.
        checkIn:             null,
      },
```

Đổi hai dòng `null` thành địa chỉ vừa deploy:

```js
        router:              '0xROUTER_ADDR_YOU_DEPLOYED',
        ...
        checkIn:             '0xCHECKIN_ADDR_YOU_DEPLOYED',
```

## 8.2. Bump cache-buster

```bash
cd /c/arc-swap-v9
for f in *.html; do
  sed -i 's|arc-core-v2\.js?v=10\.0\.0|arc-core-v2.js?v=10.0.1|g' "$f"
done
```

## 8.3. Commit + push

```bash
git -C /c/arc-swap-v9 add assets/arc-core-v2.js *.html
git -C /c/arc-swap-v9 status --short
```

Verify status chỉ show `arc-core-v2.js` và các HTML pages. **KHÔNG được có
`contracts/.env`**. Nếu có → STOP, gỡ:
```bash
git -C /c/arc-swap-v9 reset HEAD contracts/.env
```

Commit:
```bash
git -C /c/arc-swap-v9 commit -m "wire: mainnet router + checkin addresses"
git -C /c/arc-swap-v9 push origin main
```

Cloudflare Pages tự deploy trong ~90s.

---

# PHẦN 9 — Sanity swap test (~5 phút, chi phí ~$0.01 + 1 USDC swap)

Test một swap 1 USDC → EURC qua router deployed trước khi tuyên bố "live".

## 9.1. Chuẩn bị

Bạn cần một ít EURC seed để test swap ngược lại nếu muốn. Cho lần đầu, làm
1 chiều USDC → EURC là đủ.

Yêu cầu:
- Ví deployer có ≥ 2 USDC (bạn có 35.88 — thừa)
- Uniswap v4 có pool USDC/EURC trên Arc mainnet (query để verify)

```bash
# Query xem có pool USDC/EURC nào không
# Uniswap v4 PoolManager state view
cast call 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b \
  "getSlot0(bytes32)(uint160,int24,uint24,uint24)" \
  --rpc-url https://rpc.mainnet.arc.io \
  0x0000000000000000000000000000000000000000000000000000000000000000
```

(Nếu chưa có ai deploy pool USDC/EURC trên Arc mainnet, swap sẽ fail. Nếu
vậy, đợi Uniswap ecosystem seed pool — có thể vài ngày sau launch.)

## 9.2. Approve router

```bash
# Approve OneliqRouter spend USDC của bạn (MAX)
cast send 0x3600000000000000000000000000000000000000 \
  "approve(address,uint256)" \
  $ROUTER_ADDR \
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  --rpc-url $RPC --private-key $DEPLOYER_PK
```

## 9.3. Tôi sẽ build script swap sau khi bạn deploy

Uniswap v4 swap calldata phức tạp (V4_SWAP command + Actions array). Sau
khi bạn gửi tôi địa chỉ router deployed, tôi sẽ viết script Node.js dùng
`@uniswap/universal-router-sdk` build calldata + gọi `OneliqRouter.swap()`.

Cho đến lúc đó, có thể test qua Uniswap UI (khi họ mở giao diện trên Arc)
hoặc contract Universal Router trực tiếp.

---

# PHẦN 10 — Post-deploy checklist

- [ ] Deploy tx của cả 2 contract đã confirm on explorer.arc.io
- [ ] Constructor args verified qua `cast call`
- [ ] Slither chạy, không có red flag ngoài list "cố ý"
- [ ] Router + CheckIn address đã wire vào `arc-core-v2.js`
- [ ] Commit + push, Cloudflare Pages deploy xong
- [ ] Trade tab không còn banner "coming soon" (chuyển sang UI swap thật — sau khi tôi build phần v4 quote integration)
- [ ] Test 1 USDC → EURC thành công
- [ ] `accruedFees[USDC]` = 3000 (= 0.30% của 1 USDC canonical 6-dec)

---

# PHẦN 11 — Đăng bug bounty (optional, 30 phút)

Sau khi đã tin contract (Slither pass + manual check + test swap OK), post
bounty để cộng đồng test độc lập.

## 11.1. Immunefi (recommended)

1. Vào https://immunefi.com/explore/
2. Click "Launch a program" (dropdown Programs → For Projects)
3. Tạo profile Oneliq
4. Program config:
   - **Assets in scope**: paste địa chỉ OneliqRouter + OneliqCheckIn mainnet
   - **Impacts in scope**:
     - Critical: Direct theft of user funds (accrued fees hoặc unswapped tokens)
     - High: Griefing that costs users gas or fees
     - Medium: Reversible bugs
     - Low: Best-practice issues
   - **Rewards**:
     - Critical: $5k (start small, grow)
     - High: $1k
     - Medium: $300
     - Low: acknowledgement only
5. Publish

## 11.2. Nếu ai đó báo bug thật

**Không hot-patch contract**. Thay vào:
1. Call `pause()` từ owner wallet ngay lập tức
2. Deploy contract fixed ở địa chỉ mới
3. Update `_MAINNET_CHAINS.arc.contracts.router` sang địa chỉ mới
4. Call `withdrawFees` từ router cũ về treasury
5. Publish incident report (transparency)

---

# 🔥 Troubleshooting

### `forge: command not found`
Đóng terminal, mở lại. Nếu vẫn không được, chạy `foundryup` lại.

### `compilation failed` với error đỏ
Copy 20 dòng đầu của error paste cho tôi. Thường là:
- Solidity version mismatch — check `foundry.toml` có `solc_version = "0.8.24"`
- Import missing — OneliqRouter.sol không có external import, nếu vẫn báo thì file bị corrupt, copy lại

### `insufficient funds for intrinsic transaction cost`
Ví deployer không đủ USDC gas. Check:
```bash
cast balance $OWNER --rpc-url $RPC --ether
```
Cần ≥ 0.1 USDC (thực tế 0.05 là đủ nhưng để buffer). Bridge thêm qua bridge.usdc.com.

### `nonce too high` / `nonce too low`
Ví đang có tx pending. Chờ ~30s rồi thử lại. Hoặc set nonce explicit:
```bash
cast nonce $OWNER --rpc-url $RPC   # số current
# Rồi truyền vào forge create bằng --nonce N
```

### `execution reverted` khi call `cast call ROUTER_ADDR "..."`
Contract chưa được deploy tại địa chỉ đó, hoặc ABI không khớp. Verify bytecode:
```bash
cast code $ROUTER_ADDR --rpc-url $RPC | head -c 50
```
Không rỗng = deploy OK; ABI nếu vẫn revert thì check tên function chính xác (case-sensitive).

### `.env` bị track bởi git
Nếu đã lỡ commit .env:
```bash
git -C /c/arc-swap-v9 rm --cached contracts/.env
git -C /c/arc-swap-v9 commit -m "remove leaked .env"
# NHƯNG private key đã lộ nếu đã push!
# Chuyển ngay toàn bộ USDC ra ví khác, ROTATE contract ownership sang key mới
# thông qua transferOwnership + acceptOwnership. Ví cũ coi như burned.
```

### Slither không install được (`error: metadata-generation-failed`)
Cần Python dev headers:
- Windows: cài Python từ python.org (chọn "Add to PATH")
- Alternatively: dùng Docker: `docker run -v $(pwd):/src trailofbits/slither slither /src/OneliqRouter.sol`

### Uniswap v4 pool USDC/EURC chưa tồn tại trên Arc Mainnet
Cần đợi ai đó seed pool. Có 3 option:
1. Đợi Uniswap ecosystem (thường 1-2 tuần sau chain launch)
2. Deploy pool + seed liquidity tự (cần ~$1k+ USDC làm LP, IL risk)
3. Tạm dùng StableFX (Circle's RFQ engine) cho stable swap — cần rewrite router

Ping tôi khi bạn quyết.

---

# 📞 Sau khi làm xong, gửi tôi

Paste 4 dòng này:

```
ROUTER_ADDR=0x...
CHECKIN_ADDR=0x...
ROUTER_DEPLOY_TX=0x...
CHECKIN_DEPLOY_TX=0x...
```

Tôi sẽ:
1. Verify on-chain state khớp
2. Build Uniswap v4 quote + swap integration trong `trade.html` (~500 dòng JS)
3. Commit + push để user thực sự trade được trên mainnet

Nếu Slither surface finding nào bạn không rõ, paste output trước khi wire.
