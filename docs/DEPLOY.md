# Deploy — Server mode (Ubuntu VPS)

Hướng dẫn deploy `KysoQR` lên một máy chủ Ubuntu tự quản lý (mô hình "Server" trong `README.md`). Không cần database/Redis/queue — chỉ 1 tiến trình Node.js duy nhất.

> Mọi chỗ dưới đây dùng placeholder (`<server-ip-or-domain>`, `<repo-url>`, ...) — **không** ghi địa chỉ/IP máy chủ thật vào bất kỳ file nào trong repo này (repo là public open source).

## 0. Yêu cầu

- SSH vào được máy chủ Ubuntu (20.04/22.04/24.04).
- Node.js **>= 22** (theo `engines` trong `package.json` — `pdf.js` cần `Iterator.prototype.join`, chỉ có mặc định từ Node 22 trở lên; Node 20 sẽ lỗi `ReferenceError: Iterator is not defined` khi build).
- `git`.

## 1. Cài Node.js + git lần đầu

```bash
ssh ubuntu@<server-ip-or-domain>

sudo apt update && sudo apt install -y git curl

# Node.js 22 LTS qua NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # phải >= 22
```

Tạo user riêng chạy app (không chạy app bằng root):

```bash
sudo adduser --system --group --home /opt/xsign-opensource xsign
```

## 2. Clone code (nhánh `main`)

Nếu repo đang **Private**, không clone HTTPS anonymous được — tạo 1 **Deploy Key** riêng (chỉ đọc, chỉ dùng cho đúng repo này) thay vì dùng tài khoản GitHub cá nhân trên server:

```bash
# Tạo deploy key (đặt ngoài thư mục sẽ clone, tránh xung đột "thư mục không rỗng")
sudo mkdir -p /etc/xsign-opensource-deploy
sudo ssh-keygen -t ed25519 -f /etc/xsign-opensource-deploy/id_ed25519 -N "" -C "xsign-opensource-deploy"
sudo chown -R xsign:xsign /etc/xsign-opensource-deploy
sudo chmod 700 /etc/xsign-opensource-deploy
sudo chmod 600 /etc/xsign-opensource-deploy/id_ed25519

# Lấy public key để thêm vào GitHub repo → Settings → Deploy keys → Add deploy
# key (để trống "Allow write access", chỉ cần quyền đọc)
sudo cat /etc/xsign-opensource-deploy/id_ed25519.pub

# Trust sẵn host key github.com (tránh prompt yes/no khi clone)
sudo -u xsign ssh-keyscan github.com | sudo tee /etc/xsign-opensource-deploy/known_hosts > /dev/null
```

Clone bằng đúng deploy key này:

```bash
sudo -u xsign env GIT_SSH_COMMAND="ssh -i /etc/xsign-opensource-deploy/id_ed25519 -o UserKnownHostsFile=/etc/xsign-opensource-deploy/known_hosts -o IdentitiesOnly=yes" \
  git clone -b main git@github.com:KysoQR/KysoQR.git /opt/xsign-opensource
cd /opt/xsign-opensource
```

Lưu cấu hình SSH này vào repo để sau này `git pull`/`scripts/deploy.sh` không cần gõ lại:

```bash
sudo -u xsign git config core.sshCommand "ssh -i /etc/xsign-opensource-deploy/id_ed25519 -o UserKnownHostsFile=/etc/xsign-opensource-deploy/known_hosts -o IdentitiesOnly=yes"
```

Nếu repo đã chuyển sang Public, bỏ qua phần deploy key, dùng thẳng `sudo -u xsign git clone -b main <repo-url> /opt/xsign-opensource`.

## 3. Cấu hình env

```bash
sudo -u xsign cp .env.example .env
sudo -u xsign nano .env
```

Điền trực tiếp trên server (không copy-paste secret qua chat/doc):

```
CAS_ESIGN_BASE_URL=<giá trị thật>
CAS_ESIGN_CLIENT_ID=<giá trị thật>
CAS_ESIGN_API_KEY=<giá trị thật>
```

`.env` đã nằm trong `.gitignore` — không bao giờ commit file này. (Root CA tin cậy không còn cấu hình qua env nữa — đã bundle sẵn trong `lib/trustStore/roots/`, xem README ở đó nếu cần thêm root mới.)

## 4. Cài dependency + build

```bash
sudo -u xsign npm install
sudo -u xsign npm run build
```

`npm run build` tự chạy `prebuild` (`node scripts/generateCertManifest.js`) trước khi build — sinh lại `lib/trustStore/generated/*.generated.ts` từ đúng các file đang có trong `lib/trustStore/roots/`/`intermediates/`. Trên VPS bước này chỉ mang tính bổ sung (trust store đã đọc `fs` thật lúc runtime rồi) — nhưng vẫn cần chạy để giữ 2 file generated này không bị lệch nếu ai đó thêm cert mới mà quên chạy `npm run gen:certs` tay trước khi commit.

## 5. Chạy bằng systemd (tự khởi động lại, sống qua reboot)

Unit file có sẵn trong repo tại [`deploy/xsign-opensource.service`](../deploy/xsign-opensource.service) — chỉ cần copy vào đúng chỗ:

```bash
sudo cp deploy/xsign-opensource.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xsign-opensource
sudo systemctl status xsign-opensource
```

Cấp quyền cho user `xsign` được chạy đúng 2 lệnh `systemctl restart`/`status` của riêng service này mà không cần mật khẩu — bắt buộc, vì [`scripts/deploy.sh`](../scripts/deploy.sh) (chạy bằng `sudo -u xsign bash scripts/deploy.sh` ở bước 8) tự gọi `sudo systemctl restart`/`status` bên trong nó. Thiếu bước này, **lần đầu deploy vẫn chạy được** (service chưa tồn tại nên script chỉ in hướng dẫn cài thủ công), nhưng **mọi lần redeploy sau đó sẽ fail** vì `xsign` không có quyền sudo:

```bash
sudo visudo -f /etc/sudoers.d/xsign-opensource-deploy
```

Nội dung file (đường dẫn `systemctl` trên Ubuntu thường là `/usr/bin/systemctl` — kiểm tra bằng `which systemctl` nếu máy bạn khác):

```
xsign ALL=(root) NOPASSWD: /usr/bin/systemctl restart xsign-opensource, /usr/bin/systemctl status xsign-opensource --no-pager
```

## 6. Mở cổng ra ngoài

`ufw` mặc định ở trạng thái **inactive** trên Ubuntu — lệnh `ufw allow` bên dưới sẽ không có tác dụng gì (không lỗi, cũng không mở gì) nếu `ufw` chưa được bật. Kiểm tra trước:

```bash
sudo ufw status
# Nếu thấy "Status: inactive" thì bật (nhớ allow SSH TRƯỚC khi enable, kẻo tự khoá mất quyền SSH):
sudo ufw allow OpenSSH
sudo ufw enable
```

Nếu VPS thuê từ nhà cung cấp cloud (AWS/GCP/DigitalOcean/Azure...), `ufw` chỉ là firewall **trong hệ điều hành** — còn có 1 lớp firewall riêng ở hạ tầng (Security Group/Firewall Rules trên dashboard nhà cung cấp) cũng phải mở đúng port tương ứng, `ufw` không kiểm soát được lớp đó.

**Cách nhanh (test nội bộ/tạm thời)** — mở thẳng port 3000:

```bash
sudo ufw allow 3000/tcp
```

Truy cập `http://<server-ip>:3000`.

**Cách khuyến nghị cho môi trường thật** — Nginx reverse proxy + TLS (cần có domain trỏ vào server trước):

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

File mẫu có sẵn trong repo tại [`deploy/nginx.conf.example`](../deploy/nginx.conf.example) (đã bao gồm sẵn `client_max_body_size 25m` — giới hạn mặc định 1MB của Nginx nhỏ hơn hẳn giới hạn thật của app, xem giải thích ngay trong file) — chỉ cần copy vào đúng chỗ rồi sửa domain:

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/xsign-opensource
sudo nano /etc/nginx/sites-available/xsign-opensource   # thay <your-domain> bằng domain thật
```

```bash
sudo ln -s /etc/nginx/sites-available/xsign-opensource /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <your-domain>   # cấp TLS, tự động sửa config sang https
sudo ufw allow 'Nginx Full'
```

## 7. Kiểm tra sau khi deploy

```bash
sudo systemctl status xsign-opensource        # phải là "active (running)"
sudo journalctl -u xsign-opensource -n 50     # xem log, không có exception

curl -I http://127.0.0.1:3000/               # 200

# Xác nhận app đang gọi CAS thật (luôn luôn thật — không còn chế độ mock):
curl http://127.0.0.1:3000/api/verify/signing-round/khong-ton-tai
# → {"signingRound":null} do CAS thật trả về "not found"
```

## 8. Cập nhật khi có code mới trên `main`

[`scripts/deploy.sh`](../scripts/deploy.sh) gộp sẵn 4 bước trên (fetch + reset về `origin/main`, `npm install`, `npm run build`, restart service) — dùng cho cả lần deploy đầu và mọi lần sau:

```bash
cd /opt/xsign-opensource
sudo -u xsign bash scripts/deploy.sh
```

Deploy nhánh khác `main`: `sudo -u xsign bash scripts/deploy.sh <branch>`.
