# CLAUDE.md

XSign refactor — 1 app Next.js, không DB.

- **Trước khi code bất kỳ gì**: đọc và tuân thủ [`Rule/RULES.md`](Rule/RULES.md) — quy tắc cố định (lệnh build/test/lint, Definition of Done, ngưỡng bật Plan Mode, Verification Loop bắt buộc sau mỗi lần sửa code). Đây không phải gợi ý, là bắt buộc.
- **API**: nguồn sự thật là OpenAPI [`public/openapi/vi.yaml`](public/openapi/vi.yaml) + [`public/openapi/en.yaml`](public/openapi/en.yaml) (xem tương tác tại `/api/`). Khi sửa route trong `app/api/` hoặc đổi request/response/mã lỗi, cập nhật cả 2 file YAML trong cùng thay đổi — test `lib/openapi.test.ts` sẽ fail nếu route hoặc mã lỗi trong code lệch với spec.
- **Kiến trúc/quyết định thiết kế**: xem `Plan/Plan refactor.md` nếu có — tài liệu kế hoạch nội bộ, cố tình không nằm trong git/repo public; hỏi chủ dự án nếu bạn không có sẵn file này.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
