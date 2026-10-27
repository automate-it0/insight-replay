import { test, expect, describe } from "bun:test"
import { parseUA, anonymizeIP, fakeGeo } from "../src/lib/ua"

// ─── parseUA ──────────────────────────────────────────────────────────────
describe("parseUA", () => {
  describe("browser detection", () => {
    test("detects Chrome from a Windows Chrome UA string", () => {
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      expect(parseUA(ua).browser).toBe("Chrome")
    })

    test("detects Firefox from a Firefox UA string", () => {
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0"
      expect(parseUA(ua).browser).toBe("Firefox")
    })

    test("detects Safari from a Safari UA string (no Chrome token)", () => {
      // Safari UA contains "Safari/" but NOT "Chrome/" — the discriminator.
      const ua =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      expect(parseUA(ua).browser).toBe("Safari")
    })

    test("detects Edge from an Edge UA string (Edg/ token wins over Chrome/)", () => {
      // Edge UA contains BOTH "Chrome/" and "Edg/" — Edg/ must win.
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
      expect(parseUA(ua).browser).toBe("Edge")
    })

    test("detects Opera from an OPR/ UA string", () => {
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0"
      expect(parseUA(ua).browser).toBe("Opera")
    })

    test("defaults to Chrome for an empty/unknown UA", () => {
      // No browser token at all — falls through to the default "Chrome".
      expect(parseUA("").browser).toBe("Chrome")
      expect(parseUA("SomeBot/1.0").browser).toBe("Chrome")
    })
  })

  describe("device classification", () => {
    test("classifies a desktop Chrome UA as desktop", () => {
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      expect(parseUA(ua).device).toBe("desktop")
    })

    test("classifies an iPhone UA as mobile", () => {
      const ua =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      expect(parseUA(ua).device).toBe("mobile")
    })

    test("classifies an Android phone UA as mobile", () => {
      const ua =
        "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      expect(parseUA(ua).device).toBe("mobile")
    })

    test("classifies an iPad UA as tablet", () => {
      const ua =
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      expect(parseUA(ua).device).toBe("tablet")
    })

    test("classifies a generic Tablet UA as tablet", () => {
      const ua =
        "Mozilla/5.0 (Linux; Android 10; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      expect(parseUA(ua).device).toBe("tablet")
    })
  })

  describe("OS detection", () => {
    test("detects Windows from a Windows NT 10 UA", () => {
      const ua =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      expect(parseUA(ua).os).toBe("Windows")
    })

    test("detects macOS from a Mac OS X UA", () => {
      const ua =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      expect(parseUA(ua).os).toBe("macOS")
    })

    test("detects iOS from a synthetic iPhone UA (no 'Mac OS X' token)", () => {
      // NOTE: real iPhone UAs include the substring "like Mac OS X", which the
      // current parser matches before reaching the iPhone branch, so they are
      // classified as macOS. This test uses a synthetic UA without that token
      // to verify the iOS branch is reachable when iPhone/iPad/iPod appears
      // without an earlier-matching OS keyword.
      const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari/604.1"
      expect(parseUA(ua).os).toBe("iOS")
    })

    test("classifies a real iPhone UA as macOS (documented source limitation)", () => {
      // Documents the actual behaviour: real iPhone UAs contain "Mac OS X",
      // which the parser matches before the iOS branch — so iPhones are
      // reported as macOS. (This is a known limitation of the source parser;
      // per task scope, tests document behaviour rather than change source.)
      const ua =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      expect(parseUA(ua).os).toBe("macOS")
    })

    test("detects Android from an Android UA", () => {
      const ua =
        "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      expect(parseUA(ua).os).toBe("Android")
    })

    test("detects Linux from a Linux UA", () => {
      const ua =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      expect(parseUA(ua).os).toBe("Linux")
    })

    test("defaults to Windows for an unknown UA", () => {
      expect(parseUA("").os).toBe("Windows")
      expect(parseUA("SomeBot/1.0").os).toBe("Windows")
    })
  })

  test("returns a complete UAInfo object with all three fields", () => {
    const info = parseUA(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    )
    expect(info).toEqual({
      browser: "Chrome",
      os: "Windows",
      device: "desktop",
    })
  })
})

// ─── anonymizeIP ──────────────────────────────────────────────────────────
describe("anonymizeIP", () => {
  describe("IPv4", () => {
    test("zeroes the last octet of a plain IPv4 address", () => {
      expect(anonymizeIP("192.168.1.42")).toBe("192.168.1.0")
    })

    test("zeroes the last octet of a public IPv4 address", () => {
      expect(anonymizeIP("8.8.8.8")).toBe("8.8.8.0")
    })

    test("strips a trailing port before anonymizing", () => {
      expect(anonymizeIP("1.2.3.4:80")).toBe("1.2.3.0")
    })

    test("handles leading/trailing whitespace", () => {
      expect(anonymizeIP("  10.0.0.5  ")).toBe("10.0.0.0")
    })

    test("rejects an octet > 255", () => {
      expect(anonymizeIP("1.2.3.999")).toBe("0.0.0.0")
    })

    test("rejects an octet with a leading zero (e.g. 01)", () => {
      // String(n) !== p for "01" → 1, treated as invalid per the parser.
      expect(anonymizeIP("192.168.01.1")).toBe("0.0.0.0")
    })
  })

  describe("IPv6", () => {
    test("zeroes the last 4 groups of a full IPv6 address", () => {
      // 2001:db8:85a3:8d3:1319:8a2e:370:7334 → first 4 groups preserved,
      // last 4 groups (the bottom 80 bits) zeroed, then compressed to "::".
      expect(anonymizeIP("2001:db8:85a3:8d3:1319:8a2e:370:7334")).toBe(
        "2001:db8:85a3:8d3::",
      )
    })

    test("expands :: shorthand and zeroes the bottom 80 bits", () => {
      // ::1 → 8 groups: 0:0:0:0:0:0:0:1 → zero last 4 → 0:0:0:0:0:0:0:0 → "::"
      expect(anonymizeIP("::1")).toBe("::")
    })

    test("handles IPv6 in brackets (no port)", () => {
      expect(anonymizeIP("[::1]")).toBe("::")
    })

    test("handles IPv6 in brackets with a port", () => {
      expect(anonymizeIP("[::1]:443")).toBe("::")
    })

    test("rejects an IPv6 group > 0xffff", () => {
      expect(anonymizeIP("2001:db8:85a3:8d3:1319:8a2e:370:fffff")).toBe(
        "0.0.0.0",
      )
    })

    test("rejects an IPv6 with multiple :: sequences", () => {
      expect(anonymizeIP("2001::db8::1")).toBe("0.0.0.0")
    })
  })

  describe("invalid inputs", () => {
    test("returns 0.0.0.0 for an empty string", () => {
      expect(anonymizeIP("")).toBe("0.0.0.0")
    })

    test("returns 0.0.0.0 for the literal 'unknown'", () => {
      expect(anonymizeIP("unknown")).toBe("0.0.0.0")
    })

    test("returns 0.0.0.0 for a non-IP string", () => {
      expect(anonymizeIP("not-an-ip")).toBe("0.0.0.0")
    })

    test("returns 0.0.0.0 for a hostname", () => {
      expect(anonymizeIP("example.com")).toBe("0.0.0.0")
    })
  })
})

// ─── fakeGeo ──────────────────────────────────────────────────────────────
describe("fakeGeo", () => {
  test("returns an object with country and city fields", () => {
    const geo = fakeGeo("192.168.1.1")
    expect(geo).toHaveProperty("country")
    expect(geo).toHaveProperty("city")
    expect(typeof geo.country).toBe("string")
    expect(typeof geo.city).toBe("string")
    expect(geo.country.length).toBeGreaterThan(0)
    expect(geo.city.length).toBeGreaterThan(0)
  })

  test("is deterministic — same IP returns the same geo", () => {
    const a = fakeGeo("203.0.113.42")
    const b = fakeGeo("203.0.113.42")
    expect(a).toEqual(b)
  })

  test("returns a known country from the catalog for any input", () => {
    const KNOWN_COUNTRIES = new Set([
      "United States",
      "United Kingdom",
      "Germany",
      "France",
      "Japan",
      "India",
      "Brazil",
      "Canada",
      "Australia",
      "Egypt",
      "Netherlands",
      "Singapore",
      "Spain",
      "Italy",
    ])
    // Sample several IPs to confirm output is always one of the catalog entries.
    for (const ip of ["1.1.1.1", "8.8.8.8", "9.9.9.9", "10.0.0.1", "172.16.0.1"]) {
      expect(KNOWN_COUNTRIES.has(fakeGeo(ip).country)).toBe(true)
    }
  })

  test("can return different geos for different IPs", () => {
    // Hash two sufficiently different IPs and confirm at least one of them
    // produces a distinct geo (otherwise the catalog is degenerate).
    const geos = new Set(
      ["203.0.113.1", "198.51.100.1", "192.0.2.1", "203.0.113.99"].map(
        (ip) => `${fakeGeo(ip).country}/${fakeGeo(ip).city}`,
      ),
    )
    expect(geos.size).toBeGreaterThan(1)
  })
})
