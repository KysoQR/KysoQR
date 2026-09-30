# Deploy — Cloudflare Workers (edge/serverless mode)

Hướng dẫn deploy `KysoQR` lên Cloudflare Workers (mô hình "Cloud Worker" trong `README.md`). Build qua [OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare) (`@opennextjs/cloudflare`, đã có sẵn trong `devDependencies` + `wrangler.jsonc`/`open-next.config.ts` đã commit sẵn trong repo) — chỉ cần điền đúng 2 dòng lệnh khi kết nối repo lần đầu, không cần tự viết cấu hình.

## 0. Khác biệt quan trọng so với VPS

Cloudflare Workers là runtime edge/isolate (dùng engine `workerd`), **không có filesystem thật và không có network stack đầy đủ như Node.js thật** (khác hẳn VPS). Vì vậy:

- `lib/trustStore/` (đọc chứng thư CA root) không thể chỉ dựa vào đọc thư mục lúc runtime (`fs.readdirSync`) như trên VPS — cần thêm manifest sinh sẵn lúc build (`lib/trustStore/generated/rootCerts.generated.ts`, tự sinh bởi `scripts/generateCertManifest.js` qua `npm run gen:certs`/`prebuild`). Xem chi tiết cơ chế ở [`lib/trustStore/roots/README.md`](../lib/trustStore/roots/README.md). (CA trung gian không còn bundle sẵn — được dò tìm động lúc verify qua AIA `caIssuers` của từng chứng thư, xem `lib/verification/aiaCertFetcher.ts`.)
- **Quan trọng — đánh đổi bảo mật đã biết**: cơ chế chống SSRF khi gọi AIA/OCSP/CRL (`lib/verification/guardedFetch.ts`, dùng chung cho cả 3) dùng `dns.lookup` tùy chỉnh kết hợp `net.BlockList` trên VPS — cơ chế này **không hoạt động đúng trên Workers** (Workers không hỗ trợ tham số `lookup` tùy chỉnh của `http.request`, bị bỏ qua âm thầm chứ không báo lỗi). Trên Workers, module này tự động chuyển sang cách kiểm tra khác (`dns.resolve4`/`resolve6` rồi mới `fetch()`) — vẫn chặn được phần lớn SSRF thông thường (IP nội bộ, cloud metadata...) nhưng còn lại 1 khe hở hẹp hơn (tấn công DNS-rebinding có chủ đích). Đây là giới hạn thật của nền tảng Workers, không phải lỗi — xem doc comment trong chính file đó để biết chi tiết.
- File `wrangler.jsonc` và `open-next.config.ts` **đã có sẵn trong repo** (khác với hiểu lầm trước đây) — không cần tự tạo, không cần chỉnh sửa trừ khi bạn thật sự cần đổi hành vi build/deploy.

## 1. Setup lần đầu (qua dashboard Cloudflare)

Đây là dịch vụ dạng **Workers Builds** (CI build/deploy tích hợp sẵn của Cloudflare cho Workers) — **không phải** Cloudflare Pages với auto-detect framework, nên 2 ô lệnh dưới đây cần điền đúng tay 1 lần khi kết nối:

- Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git** → chọn repo `KysoQR` và branch production (ví dụ `main`).
- Ở bước cấu hình build, điền đúng:
  - **Build command**: `npm run cf:build`
  - **Deploy command**: `npx wrangler versions upload`
  - **Root directory**: `/` (mặc định)

`npm run cf:build` chạy `opennextjs-cloudflare build`, tự gọi `next build` (kèm `prebuild`/`gen:certs`) rồi đóng gói lại thành 1 Worker script thật tại `.open-next/worker.js` + tài nguyên tĩnh tại `.open-next/assets/` — đúng 2 đường dẫn mà `wrangler.jsonc`'s `main`/`assets.directory` đã khai sẵn, nên `npx wrangler versions upload` (không cần tham số gì thêm) sẽ tự tìm thấy và deploy đúng.

## 2. Cấu hình biến môi trường — ĐIỂM DỄ NHẦM NHẤT

Cloudflare có **2 chỗ cấu hình biến môi trường/secret hoàn toàn khác nhau**, cùng nằm trong tab Settings nhưng khác sub-tab:

- **Settings → Builds → Variables and secrets**: chỉ dùng lúc **build** (CI) — Worker đang chạy thật **không đọc được** các giá trị ở đây.
- **Settings → Runtime → Variables and secrets**: đây mới là nơi Worker đọc lúc xử lý **request thật** — bắt buộc điền đúng ở đây.

Điền đúng 3 biến sau ở mục **Runtime** (không phải Builds):

```
CAS_ESIGN_BASE_URL=<giá trị thật>
CAS_ESIGN_CLIENT_ID=<giá trị thật>
CAS_ESIGN_API_KEY=<giá trị thật>
```

Điền trực tiếp trên dashboard — không dán secret qua chat/doc.

Nếu thiếu hoặc điền nhầm vào tab Builds: cả 4 route gọi CAS (`/api/sign/request`, `/api/sign/status`, `/api/sign/download`, `/api/verify/signing-round/…`) sẽ trả về HTTP 500 `{"error":"CAS_NOT_CONFIGURED"}` (vì `lib/env.ts`'s `getEnv()` throw lỗi cấu hình lúc runtime), trong khi `/api/verify/upload` vẫn chạy bình thường (route này không cần các biến CAS, chỉ cần trust store).

## 3. Deploy / redeploy

Mỗi lần push code lên đúng branch đã kết nối (ví dụ `main`), Cloudflare tự động chạy lại đúng 2 lệnh Build/Deploy đã điền ở bước 1 — không cần thao tác gì thêm. `prebuild` (`node scripts/generateCertManifest.js`) tự chạy như một phần của `npm run cf:build`, nên root trust store luôn được làm mới đúng theo các file hiện có trong `lib/trustStore/roots/` tại thời điểm build — miễn là cert root mới đã được commit kèm theo file `rootCerts.generated.ts` tương ứng (xem hướng dẫn thêm cert mới ở README nói trên).

### Chạy/kiểm tra build Cloudflare cục bộ (không cần push code)

```bash
npm run cf:build     # build + đóng gói thành Worker, output tại .open-next/
npm run cf:preview   # build rồi chạy thử ngay trên máy bằng workerd (giống môi trường thật)
```

## 4. Kiểm tra sau khi deploy

- Xem log thật: dashboard → **Observability** → **Logs** (bấm vào từng dòng để xem chi tiết exception nếu có lỗi), hoặc `npx wrangler tail <tên-worker>` (đã có `wrangler` trong `devDependencies`, không cần cài riêng).
- Test xác minh 1 file PDF đã ký thật ở `https://<worker>.workers.dev/verify` — không được thấy trạng thái `Chưa cấu hình kho tin cậy` (`TRUST_STORE_NOT_CONFIGURED`). Nếu thấy, kiểm tra lại build log có dòng `[gen:certs] ...` (nghĩa là `prebuild` đã chạy) hay không.
- Test ký thử (nút "Ký") để xác nhận `/api/sign/request` không trả về HTTP 500 — nếu còn lỗi, kiểm tra lại đúng tab **Runtime** (không phải Builds) của biến môi trường.
