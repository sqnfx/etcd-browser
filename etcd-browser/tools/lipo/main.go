// Command lipo merges thin Mach-O executables into a universal (fat) binary,
// so the macOS app can be built on any platform: go run ./tools/lipo out in1 in2...
package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "użycie: lipo WYJŚCIE WEJŚCIE1 WEJŚCIE2 ...")
		os.Exit(2)
	}
	out, ins := os.Args[1], os.Args[2:]
	type slice struct {
		cpu, sub uint32
		data     []byte
	}
	var slices []slice
	for _, p := range ins {
		b, err := os.ReadFile(p)
		if err != nil {
			fail(err)
		}
		if len(b) < 12 || binary.LittleEndian.Uint32(b) != 0xfeedfacf {
			fail(fmt.Errorf("%s nie jest 64-bitowym plikiem Mach-O", p))
		}
		slices = append(slices, slice{binary.LittleEndian.Uint32(b[4:]), binary.LittleEndian.Uint32(b[8:]), b})
	}
	const align = 14 // 16 KiB pages
	hdr := make([]byte, 8+20*len(slices))
	binary.BigEndian.PutUint32(hdr[0:], 0xcafebabe)
	binary.BigEndian.PutUint32(hdr[4:], uint32(len(slices)))
	off := uint32(1 << align)
	body := []byte{}
	for i, s := range slices {
		e := hdr[8+20*i:]
		binary.BigEndian.PutUint32(e[0:], s.cpu)
		binary.BigEndian.PutUint32(e[4:], s.sub)
		binary.BigEndian.PutUint32(e[8:], off)
		binary.BigEndian.PutUint32(e[12:], uint32(len(s.data)))
		binary.BigEndian.PutUint32(e[16:], align)
		pad := int(off) - (len(hdr) + len(body))
		body = append(body, make([]byte, pad)...)
		body = append(body, s.data...)
		off = uint32(len(hdr)+len(body)+(1<<align)-1) &^ ((1 << align) - 1)
	}
	if err := os.WriteFile(out, append(hdr, body...), 0o755); err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
