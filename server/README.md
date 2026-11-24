# Server Cổng Truyện

Chạy trên Render (Web Service): Root Directory `server`, Start Command `node server.js`.
Biến môi trường: `ADMIN_USER`, `ADMIN_PASS` (tài khoản admin đầu tiên).
Sau khi deploy, dán địa chỉ Render vào dòng `const API=''` trong `www/index.html`.
Dữ liệu lưu trong file JSON tạm: Render gói miễn phí khởi động lại thì mất dữ liệu.
