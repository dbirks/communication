// M3 probe helper — tiny stdlib-only listeners used by p3/p4.
//   node m3-net.mjs tcp   [<host>] [<port>]   → prints "LISTEN <addr> <port>", echoes "M3-ECHO <n>"
//   node m3-net.mjs unix  <path>             → prints "LISTEN unix <path>",  echoes "M3-ECHO unix"
// No dependencies: node is present on the host and in communication-worker:dev.
import net from 'node:net';
import fs from 'node:fs';

const mode = process.argv[2];
if (mode === 'tcp') {
    const host = process.argv[3] || '127.0.0.1';
    const port = Number(process.argv[4] || 0);
    const srv = net.createServer((sock) => {
        sock.on('data', () => { sock.write('HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nM3-ECHO tcp'); sock.end(); });
        sock.on('error', () => {});
    });
    srv.listen(port, host, () => {
        console.log(`LISTEN ${host} ${srv.address().port}`);
    });
} else if (mode === 'unix') {
    const path = process.argv[3];
    try { fs.unlinkSync(path); } catch {}
    const srv = net.createServer((sock) => {
        sock.on('data', () => { sock.write('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nM3-ECHO unix'); sock.end(); });
        sock.on('error', () => {});
    });
    srv.listen(path, () => {
        console.log(`LISTEN unix ${path}`);
        try { fs.chmodSync(path, 0o777); } catch {}
    });
} else {
    console.error('usage: node m3-net.mjs tcp|unix [target]');
    process.exit(2);
}
