# Proxifly Proxy Switcher (Chrome/Edge)

Ekstensi browser untuk switch proxy cepat menggunakan daftar dari:

- `https://github.com/proxifly/free-proxy-list`

## Fitur

- Ambil daftar proxy terbaru dari proxifly (`data.json`)
- Filter protocol (`http`, `https`, `socks4`, `socks5`)
- `Random Switch` dan `Next` proxy
- Pilih manual dari list lalu apply
- Tombol `Matikan Proxy`
- Cek IP publik (opsional) dari popup

## Cara pakai

1. Buka `chrome://extensions` (atau `edge://extensions`)
2. Aktifkan `Developer mode`
3. Klik `Load unpacked`
4. Pilih folder: `extensions/proxifly-switcher`
5. Pin ekstensi lalu klik icon-nya
6. Klik `Refresh Daftar` lalu `Random Switch` / pilih proxy manual

## Catatan penting

- Ini hanya mengubah proxy untuk traffic browser (Chrome/Edge), bukan system-wide proxy.
- Proxy gratis sering mati/lambat. Kalau web tidak bisa dibuka, klik `Matikan Proxy` atau switch ke proxy lain.
- Beberapa situs tetap bisa mendeteksi proxy/VPN/datacenter IP.
- `chrome.proxy` bisa bentrok jika ada ekstensi proxy lain yang juga aktif.
