# Panduan Kamera IP (Hikvision DS-2CD1021G0-I) sebagai Input

Kamera IP mengirim gambar lewat jaringan (protokol **RTSP**), bukan lewat USB.
Sejak perubahan ini dashboard punya sumber ketiga, **"Kamera IP (CCTV)"**, di
samping "File video" dan "Kamera" (USB).

---

## 1. Sambungan fisik (tanpa router / PoE injector)

```
Adaptor 12V DC ──► Kamera ──kabel LAN biasa──► port LAN mini PC
```

- Daya: adaptor **12 V, 1 A** (2 A boleh), colokan **5,5 × 2,1 mm**, kutub
  tengah positif ("adaptor CCTV 12V"). Colok ke jack 12V DC di kabel ekor kamera.
  Alternatif: switch PoE / PoE injector 802.3af.
- Port LAN mini PC dipakai kamera, jadi **internet harus lewat Wi-Fi** (atau USB
  Wi-Fi / tethering HP). Suara peringatan (edge-TTS) butuh internet.

## 2. IP manual di mini PC

Kamera Hikvision baru memakai IP `192.168.1.64`. Mini PC harus satu jaringan:

1. `Windows + R` → ketik `ncpa.cpl` → Enter.
2. Klik kanan **Ethernet** → **Properties** → **Internet Protocol Version 4 (TCP/IPv4)** → **Properties**.
3. **Use the following IP address**: IP `192.168.1.10`, Subnet mask `255.255.255.0`,
   Default gateway **kosong**, DNS **kosong** → OK.

Atau, di Command Prompt **Run as administrator**:

```
netsh interface ipv4 set address name="Ethernet" static 192.168.1.10 255.255.255.0
```

Cek: `ping 192.168.1.64` harus menjawab `Reply from 192.168.1.64`.
Kembali ke otomatis: `netsh interface ipv4 set address name="Ethernet" dhcp`.

## 3. Aktivasi dan pengaturan kamera

1. Unduh **SADP Tool** dari situs resmi Hikvision → kamera muncul di daftar →
   buat password admin (aktivasi). Catat password ini.
2. Buka `http://192.168.1.64` di browser, login `admin`.
3. **Configuration → Video/Audio → Video → Main Stream**:
   - Video Encoding **H.264** (bukan H.265), H.264+ **mati**
   - Resolution **1920×1080**
   - Frame Rate **10 fps** (AI memproses ±1 frame per detik; fps tinggi hanya membebani CPU)
   - I-Frame Interval **20**
4. Uji di VLC: *Media → Open Network Stream* →
   `rtsp://admin:PASSWORD@192.168.1.64:554/Streaming/Channels/101`.
   Gambar muncul = kamera siap.

## 4. Pakai di dashboard

1. Jalankan `start_minipc.bat` seperti biasa.
2. Langkah **1 Sumber video** → **Kamera IP (CCTV)** → isi:
   - Alamat IP kamera: `192.168.1.64` (port 554 otomatis; `ip:port` juga boleh)
   - Username: `admin`
   - Password: password aktivasi
3. **Lanjut** → pilih **Seluruh frame** atau **Gambar zona** seperti biasa.

Dashboard memakai stream utama Hikvision (`/Streaming/Channels/101`).
Password:
- tidak dicetak di log;
- disamarkan (`***`) di `/status`, `/debug`, dan pesan galat;
- selama sesi berjalan disimpan **terenkripsi** (Windows DPAPI, hanya bisa dibuka akun Windows yang sama di mini
  PC ini) di `outputs\sesi_kamera\sesi_aktif.json`, supaya backend yang mati mendadak bisa menyambung ulang
  sendiri. File itu dihapus saat sumber diganti dari dashboard.

## 5. Perilaku sumber langsung (webcam dan kamera IP)

| Hal | File video | Webcam USB / Kamera IP |
|---|---|---|
| Frame yang diproses | maju 1 detik video per tick | frame **terbaru** (kamera IP: thread pembaca membuang frame lama) |
| Detik logika (durasi parkir) | 0, 1, 2, … per tick | **jam nyata** sejak deteksi dimulai; tick yang lambat melompati detik, tick yang cepat menunggu detik berikutnya |
| Stream putus | — | dibaca ulang, dibuka ulang 3×, lalu **disambung ulang terus tanpa batas** (jeda 2, 5, 10, 20, lalu tiap 30 detik; status "Kamera terputus, menyambung ulang"). Data kendaraan tidak dihapus dan durasinya tetap mengikuti jam nyata. |
| Backend mati mendadak | — | jendela backend menjalankannya lagi otomatis (`--ulang` di `start_minipc.bat`). Sesi yang disimpan ≤ 10 menit sebelumnya **dilanjutkan**: kamera, zona, kendaraan, dan durasinya. |

Sebelumnya webcam menghitung 1 tick = 1 detik, sehingga di mini PC (1–2 detik
per tick) durasi parkir tercatat lebih pendek dari kenyataan. Sekarang ambang
60 detik / 300 detik berarti 60 / 300 detik nyata.

### 5a. Sesi kamera: log TXT, screenshot, peringatan suara

**Sesi kamera:**
- Satu sesi = sejak deteksi kamera dimulai sampai sumber diganti dari dashboard. Backend yang mati lalu hidup lagi
  dalam 10 menit tetap sesi yang sama.
- Hasilnya ada di `outputs\sesi_kamera\<tanggal_jam mulai>\`:

| File | Isi |
|---|---|
| `log_deteksi_<tanggal_jam>.txt` | Satu baris per kendaraan yang **sudah berhenti** di zona, ditulis saat kendaraan itu pergi dari zona, bergerak lagi, zonanya diubah, atau sesi berakhir. Kolomnya: LID, jenis + warna, zona, jam mulai dan selesai berhenti, **durasi berhenti**, **status saat keluar** (memantau / peringatan / pelanggaran / aman-segitiga), segitiga pengaman, keterangan. Juga dicatat kejadian sesi: kamera terputus / tersambung lagi, backend hidup lagi, zona diubah, screenshot. Penutup log berisi ringkasan. |
| `screenshot\pelanggaran_<tanggal_jam>.jpg` | Frame hasil deteksi (kotak + label) dan daftar pelanggar. Diambil saat pelanggar pertama muncul, lalu tiap **5 menit** selama masih ada pelanggar. |

**Yang dicatat dan tidak:**
- Kendaraan yang hanya lewat (tidak pernah diam ≥ 3 detik) tidak dicatat: durasi berhentinya nol.
- Kendaraan yang pergi hilang dari dashboard begitu tidak terlihat lagi. Barisnya di log ditulis setelah record-nya
  dibuang (20–80 detik kemudian, waktu tunggu bila kendaraan hanya tertutup sebentar). Jam "Selesai berhenti"
  tetap jam terakhir ia terlihat diam.

**Peringatan suara:**
- Selama masih ada pelanggar: satu kalimat untuk semua pelanggar, diucapkan **2×**, diulang tiap **30 detik**.
- Pelanggar pertama langsung disuarakan.
- Pelanggar yang tertutup kendaraan lewat ≤ 10 detik tetap disebut.

## 6. Masalah umum

| Gejala | Penyebab / solusi |
|---|---|
| "Sumber tidak bisa dibuka: kamera IP …" (±5 detik setelah Lanjut) | IP salah / tidak terjangkau, atau password salah. Cek `ping` dan VLC dengan alamat yang sama. Tiap percobaan hanya login **sekali** ke kamera. |
| Password benar tapi tetap ditolak | Kamera Hikvision mengunci login dari IP yang beberapa kali salah password (±30 menit). Tunggu, atau restart kamera (cabut adaptor). |
| "Kamera terputus, menyambung ulang" | Stream putus di tengah jalan (kabel / adaptor lepas, kamera restart). Cukup sambungkan lagi: sistem terus mencoba dan melanjutkan sesi sendiri. |
| Backend tiba-tiba mati / kembali ke prompt, Event Viewer: python.exe `0xc0000006`, "error ... during a paging operation" | **Disk (SSD) mini PC bermasalah**: Windows gagal membaca program dari disk. Backend dijalankan lagi otomatis dan sesi dilanjutkan, tetapi akar masalahnya perangkat keras: cek kabel SATA, jalankan `chkdsk C: /f` (perlu restart), perbarui firmware SSD, atau ganti SSD. |
| `ping` gagal | IP mini PC belum diatur (langkah 2), kamera belum menyala, atau IP kamera sudah diubah (lihat di SADP). |
| VLC jalan, dashboard tidak | Pastikan Main Stream H.264. Coba password tanpa simbol bila memakai `% # ? /`. |
| Gambar bercak abu-abu | Sudah dicegah (RTSP lewat TCP). Bila masih, turunkan bitrate / fps di kamera. |
| Peringatan suara tidak bunyi | Mini PC tidak punya internet (port LAN dipakai kamera) → sambungkan Wi-Fi. |

## 7. File yang berubah (salin ke mini PC)

Mini PC tidak memakai git. Salin lima file ini ke folder yang sama di mini PC:

```
backend\processor.py
backend\main.py
parking-dashboard\src\App.jsx
parking-dashboard\src\index.css
parking-dashboard\src\components\SetupWizard.jsx
```

Lalu **hapus folder `parking-dashboard\dist`** di mini PC. `start_minipc.bat`
hanya mem-build dashboard bila `dist` belum ada, jadi tanpa langkah ini
tampilan lama yang terpakai. Build ulang butuh internet sekali (`npm install`).

Tidak ada paket Python baru; `opencv-python` yang sudah terpasang membaca RTSP.

Update sesi kamera (11-11-2026) menambah / mengubah:

```
backend\live_session.py              (baru)
backend\processor.py
backend\main.py
backend\shared.py
tools\disable_quickedit.py
start_minipc.bat
parking-dashboard\src\App.jsx
parking-dashboard\src\components\SetupWizard.jsx
```
