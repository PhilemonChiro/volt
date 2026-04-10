chip esp8266

hardware {
    pin p0: Output = 0
    pin p2: Output = 2
    pin p4: Output = 4
    pin p5: Output = 5
    pin p12: Output = 12
    pin p13: Output = 13
    pin p14: Output = 14
    pin p15: Output = 15
    pin p16: Output = 16
}

var c0: int = 0
var c2: int = 0
var c4: int = 0
var c5: int = 0
var c12: int = 0
var c13: int = 0
var c14: int = 0
var c15: int = 0
var c16: int = 0
var net_count: int = 0

task t1() {
    every 100ms {
        p0.toggle()
        c0 = c0 + 1
    }
}
task t2() {
    every 200ms {
        p2.toggle()
        c2 = c2 + 1
    }
}
task t3() {
    every 300ms {
        p4.toggle()
        c4 = c4 + 1
    }
}
task t4() {
    every 400ms {
        p5.toggle()
        c5 = c5 + 1
    }
}
task t5() {
    every 500ms {
        p12.toggle()
        c12 = c12 + 1
    }
}
task t6() {
    every 600ms {
        p13.toggle()
        c13 = c13 + 1
    }
}
task t7() {
    every 700ms {
        p14.toggle()
        c14 = c14 + 1
    }
}
task t8() {
    every 800ms {
        p15.toggle()
        c15 = c15 + 1
    }
}
task t9() {
    every 900ms {
        p16.toggle()
        c16 = c16 + 1
    }
}

task net() {
    every 10seconds {
        net_count = net_count + 1
        mqtt.send_int("stress/alive", net_count)
        log("net", "#" + net_count + " mqtt sent")
    }
}

task stress_report() {
    every 5seconds {
        log("stress", "=== ESP8266 STRESS REPORT ===")
        log("stress", "  GPIO0=" + c0 + " GPIO2=" + c2 + " GPIO4=" + c4 + " GPIO5=" + c5)
        log("stress", "  GPIO12=" + c12 + " GPIO13=" + c13 + " GPIO14=" + c14 + " GPIO15=" + c15 + " GPIO16=" + c16)
        log("stress", "  net_reports=" + net_count)
        log("stress", "  wifi=" + wifi.is_connected() + " heap=" + system.free_heap())
        log("stress", "  expected after 10s: g0~100 g2~50 g4~33 g5~25 g12~20")
        log("stress", "=============================")
    }
}

main {
    log("system", "=== ESP8266 STRESS TEST ===")
    log("system", "9 pins: ALL usable GPIOs on ESP8266 (0,2,4,5,12,13,14,15,16)")
    log("system", "11 tasks: 9 toggle + 1 net + 1 report")
    log("system", "RAM: 80KB total — monitor heap for leaks")
    log("system", "connecting...")
    wifi.connect("StressNet", "password")
    mqtt.connect("mqtt://broker.local")
    log("system", "starting 11 tasks on single-core Xtensa LX106")
    run(t1, t2, t3, t4, t5, t6, t7, t8, t9, net, stress_report)
}
