# Error Tracking Service (Prometheus Exporter)

Service berbasis Hono dan Bun ini menerima log dari `rsyslog` via modul `omhttp` dan mengekspos banyaknya error dalam format metrik Prometheus.

## Requirements

- [Bun](https://bun.sh/)
- Aplikasi Nginx & Rsyslog yang sudah dikonfigurasi
- Prometheus (Optional, untuk *scraping* metrik)

## Menjalankan Service

```bash
bun install
bun run index.ts
```

Service akan berjalan secara default di `http://localhost:3000`. Jika ingin mengubah port:
```bash
PORT=8080 bun run index.ts
```

## API Endpoints

### 1. Menerima Log (POST `/api/logs`)
Endpoint ini digunakan oleh rsyslog `omhttp` untuk mengirim log. Dapat menerima baik payload objek tunggal maupun array (batch mode).

**Contoh Payload:**
```json
{
  "timestamp": "2026-02-26T15:00:00Z",
  "host": "api.example.com",
  "method": "POST",
  "path": "/api/v1/auth",
  "status": "500",
  "message": "Nginx error log..."
}
```

### 2. Metrik Prometheus (GET `/metrics`)
Endpoint standar Prometheus yang menghitung total error serta *gauge* indikator banyaknya error dalam waktu ke belakang.

**Contoh Response:**
```text
# HELP error_count_total The total number of errors received since start.
# TYPE error_count_total counter
error_count_total{host="api.example.com",method="POST",path="/api/v1/auth",status="500"} 120

# HELP error_count_1m The number of errors received in the last 1 minute.
# TYPE error_count_1m gauge
error_count_1m{host="api.example.com",method="POST",path="/api/v1/auth",status="500"} 5
```

---

## Konfigurasi Nginx (`nginx.conf`)

Untuk mengirim log dengan format JSON khusus ke rsyslog, Anda perlu mendefinisikan `log_format` di konfigurasi Nginx dan arahkan `error_log` atau `access_log` ke rsyslog via syslog protokol. 

> *Catatan: Nginx secara default tidak bisa memformat `error_log` menjadi JSON secara native seperti `access_log`. Jika Anda ingin mendeteksi HTTP 5xx errors (yang merupakan request masuk), maka gunakan `access_log` dengan format JSON khusus.*

```nginx
http {
    # 1. Buat format log JSON kustom
    log_format json_error_log escape=json '{'
        '"timestamp":"$time_iso8601",'
        '"host":"$host",'
        '"method":"$request_method",'
        '"path":"$request_uri",'
        '"status":"$status",'
        '"message":"$request"'
    '}';

    server {
        listen 80;
        server_name api.example.com;

        # 2. Kirim access_log yang statusnya 4xx atau 5xx ke lokal rsyslog (port 514)
        # Atau filter langsung di rsyslog nantinya
        access_log syslog:server=127.0.0.1:514,facility=local7,tag=nginx_error,severity=error json_error_log;
        
        # log standar tetap jalan
        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;

        location / {
            # ...
        }
    }
}
```

---

## Konfigurasi Rsyslog (`rsyslog.conf` atau `/etc/rsyslog.d/error_rate.conf`)

Rsyslog bertugas menerima syslog dari Nginx (tag `nginx_error`), mengambil raw JSON-nya, dan memuatnya ke dalam batch HTTP POST menggunakan `omhttp` ke Web Service kita.

```syslog
# Pastikan modul koneksi masuk dan keluar sudah di-load
module(load="imudp") # Untuk nerima dari Nginx via UDP syslog
input(type="imudp" port="514")

module(load="omhttp") # Untuk ngirim ke web service

# Format template untuk meneruskan payload JSON murni dari Nginx ($msg)
# Kita masukkan ke dalam array json agar bisa dibaca web service dalam batch
template(name="httpJsonTemplate" type="list") {
    constant(value="[")
    property(name="msg")
    constant(value="]")
}

# 1. Filter log dari Nginx (berdasarkan tag 'nginx_error' yang kita set)
if $programname == 'nginx_error' then {
  # 2. Kirim ke Web Service Error Rate
  action(
    type="omhttp"
    server="127.0.0.1"      # Sesuaikan IP web service Hono
    serverport="3000"       # Sesuaikan Port web service Hono
    restpath="api/logs"
    template="httpJsonTemplate"
    batch.size="10"         # Pengiriman batch per 10 logs
    batch.timeout="2000"    # Atau kirim tiap 2 detik jika log sepi
    errorfile="/var/log/omhttp_errors.log"
  )
  
  # Hentikan proses agar log ini tidak tertulis ke /var/log/syslog biasa
  stop
}
```

## Konfigurasi Prometheus (`prometheus.yml`)

Tambahkan service ini ke target scraping Prometheus Anda:

```yaml
scrape_configs:
  - job_name: 'error_tracker'
    static_configs:
      - targets: ['localhost:3000']
```
