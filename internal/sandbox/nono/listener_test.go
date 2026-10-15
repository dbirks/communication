package nono_test

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// testListener is the loopback endpoint the egress probe connects to. It exists
// so the case-13 assertion is about *a* TCP connect rather than about reaching
// the internet, which no lab run should depend on.
type testListener struct {
	ln net.Listener
	// socketPath is an AF_UNIX endpoint for the socket probe, or empty.
	socketPath string
}

func startTestListener() (*testListener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("hello from the probe listener\n"))
			_ = c.Close()
		}
	}()
	return &testListener{ln: ln}, nil
}

func (l *testListener) host() string {
	host, _, _ := net.SplitHostPort(l.ln.Addr().String())
	return host
}

func (l *testListener) port() string {
	_, port, _ := net.SplitHostPort(l.ln.Addr().String())
	return port
}

func (l *testListener) close() { _ = l.ln.Close() }

// startUnixListener opens an AF_UNIX socket under the lab scratch dir, for the
// C7/C-SOCK assertion that af_unix_mediation=pathname closes connect() to a
// socket that is not granted.
func startUnixListener(dir string) (*testListener, error) {
	path := dir + "/probe.sock"
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("unix hello\n"))
			_ = c.Close()
		}
	}()
	return &testListener{ln: ln, socketPath: path}, nil
}

func (l *testListener) unixProbeCommand() string {
	return fmt.Sprintf("curl -sS --max-time 5 --unix-socket %s http://localhost/ 2>&1 || echo SOCK_DENIED", l.socketPath)
}

var _ = strings.TrimSpace
