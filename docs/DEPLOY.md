# Deploy — Server mode (Ubuntu VPS)

Hướng dẫn deploy `KysoQR` lên một máy chủ Ubuntu tự quản lý (mô hình "Server" trong `README.md`). Không cần database/Redis/queue — chỉ 1 tiến trình Node.js duy nhất.

> Mọi chỗ dưới đây dùng placeholder (`<server-ip-or-domain>`, `<repo-url>`, ...) — **không** ghi địa chỉ/IP máy chủ thật vào bất kỳ file nào trong repo này (repo là public open source).

## 0. Yêu cầu

- SSH vào được máy chủ Ubuntu (20.04/22.04/24.04).
- Node.js **>= 22.23.4** (bản vá bảo mật Node ngày 21/10/2026, sửa lỗi kiểm tra hostname TLS và lỗi giải nén Brotli; theo `engines` trong `package.json` — `pdf.js` cần `Iterator.prototype.join`, chỉ có mặc định từ Node 22 trở lên; Node 20 sẽ lỗi `ReferenceError: Iterator is not defined` khi build).
- `git`.

## 1. Cài Node.js + git lần đầu

```bash
ssh ubuntu@<server-ip-or-domain>

sudo apt update && sudo apt install -y git curl

# Node.js 22 LTS qua NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # phải >= 22.23.4
```

Đã cài Node từ trước thì chỉ cần nâng lên bản vá mới nhất của nhánh 22 rồi restart service (không cần build lại):

```bash
sudo apt update && sudo apt install --only-upgrade -y nodejs
node -v   # phải >= 22.23.4
sudo systemctl restart kysoqr
```

Tạo user riêng chạy app (không chạy app bằng root):

```bash
sudo adduser --system --group --home /opt/kysoqr xsign
```

## 2. Clone code (nhánh `main`)

Nếu repo đang **Private**, không clone HTTPS anonymous được — tạo 1 **Deploy Key** riêng (chỉ đọc, chỉ dùng cho đúng repo này) thay vì dùng tài khoản GitHub cá nhân trên server:

```bash
# Tạo deploy key (đặt ngoài thư mục sẽ clone, tránh xung đột "thư mục không rỗng")
sudo mkdir -p /etc/kysoqr-deploy
sudo ssh-keygen -t ed25519 -f /etc/kysoqr-deploy/id_ed25519 -N "" -C "kysoqr-deploy"
sudo chown -R xsign:xsign /etc/kysoqr-deploy
sudo chmod 700 /etc/kysoqr-deploy
sudo chmod 600 /etc/kysoqr-deploy/id_ed25519

# Lấy public key để thêm vào GitHub repo → Settings → Deploy keys → Add deploy
# key (để trống "Allow write access", chỉ cần quyền đọc)
sudo cat /etc/kysoqr-deploy/id_ed25519.pub

# Trust sẵn host key github.com (tránh prompt yes/no khi clone)
sudo -u xsign ssh-keyscan github.com | sudo tee /etc/kysoqr-deploy/known_hosts > /dev/null
```

Clone bằng đúng deploy key này:

```bash
sudo -u xsign env GIT_SSH_COMMAND="ssh -i /etc/kysoqr-deploy/id_ed25519 -o UserKnownHostsFile=/etc/kysoqr-deploy/known_hosts -o IdentitiesOnly=yes" \
  git clone -b main git@github.com:KysoQR/KysoQR.git /opt/kysoqr
cd /opt/kysoqr
```

Lưu cấu hình SSH này vào repo để sau này `git pull`/`scripts/deploy.sh` không cần gõ lại:

```bash
sudo -u xsign git config core.sshCommand "ssh -i /etc/kysoqr-deploy/id_ed25519 -o UserKnownHostsFile=/etc/kysoqr-deploy/known_hosts -o IdentitiesOnly=yes"
```

Nếu repo đã chuyển sang Public, bỏ qua phần deploy key, dùng thẳng `sudo -u xsign git clone -b main <repo-url> /opt/kysoqr`.

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
APP_ORIGIN=https://<your-domain>
TRUSTED_IP_HEADER=x-real-ip
```

`APP_ORIGIN` là địa chỉ công khai của site (scheme + host, không có đường dẫn, không có `/` ở cuối). Các chuyển hướng do `proxy.ts` tạo (`/verify` → `/verify/`) lấy gốc từ đây thay vì từ header `Host`/`X-Forwarded-Proto` của request — hai header mà người gọi tự chọn được. Bỏ trống thì app chỉ chấp nhận `Host` đúng dạng tên miền, nhưng vẫn phản chiếu nó; ở production hãy đặt.

`TRUSTED_IP_HEADER` cho app biết lấy IP người dùng từ header nào để giới hạn tốc độ. `X-Real-IP` do nginx tự đặt từ kết nối thật (xem `deploy/nginx.conf.example`) nên client không chọn được. Bỏ trống thì app tin `CF-Connecting-IP`/`X-Forwarded-For` — hai header mà ai kết nối thẳng tới app cũng gửi giả được, nên giới hạn tốc độ bị lách chỉ bằng cách đổi giá trị header mỗi request. (Trên Cloudflare Worker thì **để trống**: ở đó `CF-Connecting-IP` do chính Cloudflare đặt.)

`.env` đã nằm trong `.gitignore` — không bao giờ commit file này. (Root CA tin cậy không còn cấu hình qua env nữa — đã bundle sẵn trong `lib/trustStore/roots/`, xem README ở đó nếu cần thêm root mới.)

## 4. Cài dependency + build

```bash
sudo -u xsign npm install
sudo -u xsign npm run build
```

`npm run build` tự chạy `prebuild` (`node scripts/generateCertManifest.js`) trước khi build — sinh lại `lib/trustStore/generated/*.generated.ts` từ đúng các file đang có trong `lib/trustStore/roots/`/`intermediates/`. Trên VPS bước này chỉ mang tính bổ sung (trust store đã đọc `fs` thật lúc runtime rồi) — nhưng vẫn cần chạy để giữ 2 file generated này không bị lệch nếu ai đó thêm cert mới mà quên chạy `npm run gen:certs` tay trước khi commit.

## 5. Chạy bằng systemd (tự khởi động lại, sống qua reboot)

Unit file có sẵn trong repo tại [`deploy/kysoqr.service`](../deploy/kysoqr.service) — chỉ cần copy vào đúng chỗ:

```bash
sudo cp deploy/kysoqr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kysoqr
sudo systemctl status kysoqr
```

Unit chạy `next start -H 127.0.0.1` nên Node **chỉ nghe ở loopback**: nginx là đường vào duy nhất. Nếu server đã chạy bản unit cũ (không có `-H`), copy lại file mới rồi nạp lại:

```bash
sudo cp deploy/kysoqr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart kysoqr
sudo ss -ltnp | grep ':3000'   # phải thấy 127.0.0.1:3000, không phải 0.0.0.0:3000 hay *:3000
```

Cấp quyền cho user `xsign` được chạy đúng 2 lệnh `systemctl restart`/`status` của riêng service này mà không cần mật khẩu — bắt buộc, vì [`scripts/deploy.sh`](../scripts/deploy.sh) (chạy bằng `sudo -u xsign bash scripts/deploy.sh` ở bước 8) tự gọi `sudo systemctl restart`/`status` bên trong nó. Thiếu bước này, **lần đầu deploy vẫn chạy được** (service chưa tồn tại nên script chỉ in hướng dẫn cài thủ công), nhưng **mọi lần redeploy sau đó sẽ fail** vì `xsign` không có quyền sudo:

```bash
sudo visudo -f /etc/sudoers.d/kysoqr-deploy
```

Nội dung file (đường dẫn `systemctl` trên Ubuntu thường là `/usr/bin/systemctl` — kiểm tra bằng `which systemctl` nếu máy bạn khác):

```
xsign ALL=(root) NOPASSWD: /usr/bin/systemctl restart kysoqr, /usr/bin/systemctl status kysoqr --no-pager
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

**Không mở port 3000 ra ngoài.** Service chỉ nghe ở `127.0.0.1` (`-H 127.0.0.1` trong `deploy/kysoqr.service`), nên `ufw allow 3000/tcp` cũng không vào được — và không nên: ai chạm thẳng được vào Node thì bỏ qua nginx, tức bỏ qua IP thật do nginx đặt, các giới hạn tốc độ và giới hạn kích thước body. Muốn thử nhanh từ máy bạn khi chưa có domain, mở đường hầm SSH:

```bash
ssh -L 3000:127.0.0.1:3000 ubuntu@<server-ip-or-domain>
# rồi mở http://localhost:3000 trên máy bạn
```

**Cách khuyến nghị cho môi trường thật** — Nginx reverse proxy + TLS (cần có domain trỏ vào server trước):

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

File mẫu có sẵn trong repo tại [`deploy/nginx.conf.example`](../deploy/nginx.conf.example) (đã bao gồm sẵn `client_max_body_size 25m` — giới hạn mặc định 1MB của Nginx nhỏ hơn hẳn giới hạn thật của app, xem giải thích ngay trong file) — chỉ cần copy vào đúng chỗ rồi sửa domain:

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/kysoqr
sudo nano /etc/nginx/sites-available/kysoqr   # thay <your-domain> bằng domain thật
```

```bash
sudo ln -s /etc/nginx/sites-available/kysoqr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <your-domain>   # cấp TLS, tự động sửa config sang https
sudo ufw allow 'Nginx Full'
```

File mẫu còn làm bốn việc khác ngoài proxy, giải thích ngay trong file:

1. **IP thật**: đặt `X-Real-IP` từ kết nối TCP thật; chỉ tin `CF-Connecting-IP` khi kết nối đến từ dải IP của Cloudflare (danh sách lấy từ <https://www.cloudflare.com/ips/> — cập nhật khi Cloudflare đổi) và xoá bản `CF-Connecting-IP` do client tự gửi. Đây là thứ `TRUSTED_IP_HEADER=x-real-ip` ở mục 3 dựa vào.
2. **Đóng kết nối ngay** với request mang header `Next-Action`: app không dùng Server Action, đó là bot dò lỗ hổng (log hiện `Server Reference ID ... Received "x"`).
3. **Từ chối file ẩn** (`/.env`, `/.git`, ...), chừa `/.well-known` cho certbot.
4. **Giới hạn tốc độ và kích thước body riêng** cho `/api/vneid/*`, và chỉ cho `POST` vào `/api/vneid/webhook`.

Sau mỗi lần sửa file nginx: `sudo nginx -t && sudo systemctl reload nginx`.

## 7. Kiểm tra sau khi deploy

```bash
sudo systemctl status kysoqr        # phải là "active (running)"
sudo journalctl -u kysoqr -n 50     # xem log, không có exception

curl -I http://127.0.0.1:3000/               # 200
sudo ss -ltnp | grep ':3000'                 # 127.0.0.1:3000 — không được là 0.0.0.0:3000 hay *:3000
# Request mang header Next-Action phải bị nginx đóng kết nối (curl báo "Empty reply from server"):
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Next-Action: x' http://127.0.0.1/

# Xác nhận app đang gọi CAS thật (luôn luôn thật — không còn chế độ mock):
curl http://127.0.0.1:3000/api/verify/signing-round/khong-ton-tai
# → {"signingRound":null} do CAS thật trả về "not found"
```

## 8. Cập nhật khi có code mới trên `main`

[`scripts/deploy.sh`](../scripts/deploy.sh) gộp sẵn 4 bước trên (fetch + reset về `origin/main`, `npm install`, `npm run build`, restart service) — dùng cho cả lần deploy đầu và mọi lần sau:

```bash
cd /opt/kysoqr
sudo -u xsign bash scripts/deploy.sh
```

Deploy nhánh khác `main`: `sudo -u xsign bash scripts/deploy.sh <branch>`.
