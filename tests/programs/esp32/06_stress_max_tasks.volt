chip esp32

hardware {
    pin p1: Output = 2
    pin p2: Output = 4
    pin p3: Output = 5
    pin p4: Output = 13
    pin p5: Output = 14
    pin p6: Output = 16
    pin p7: Output = 17
    pin p8: Output = 18
    pin p9: Output = 19
    pin p10: Output = 21
    pin p11: Output = 22
    pin p12: Output = 23
    pin a1: Analog = 32
    pin a2: Analog = 33
    pin a3: Analog = 34
    pin a4: Analog = 35
    pin a5: Analog = 36
    pin a6: Analog = 39
}

task t1() {
    every 100ms {
        p1.toggle()
    }
}
task t2() {
    every 200ms {
        p2.toggle()
    }
}
task t3() {
    every 300ms {
        p3.toggle()
    }
}
task t4() {
    every 400ms {
        p4.toggle()
    }
}
task t5() {
    every 500ms {
        p5.toggle()
    }
}
task t6() {
    every 600ms {
        p6.toggle()
    }
}
task t7() {
    every 700ms {
        p7.toggle()
    }
}
task t8() {
    every 800ms {
        p8.toggle()
    }
}
task t9() {
    every 900ms {
        p9.toggle()
    }
}
task t10() {
    every 1seconds {
        p10.toggle()
    }
}

task isr1() {
    every 1ms strict {
        p11.toggle()
    }
}

task isr2() {
    every 500ms strict {
        p12.toggle()
    }
}

task adc_poll() {
    every 100ms {
        let v1 = a1.read()
        let v2 = a2.read()
        let v3 = a3.read()
        let v4 = a4.read()
        let v5 = a5.read()
        let v6 = a6.read()
    }
}

task net_report() {
    every 10seconds {
        mqtt.send_int("stress/a1", a1.read())
        mqtt.send_int("stress/a2", a2.read())
        mqtt.send_int("stress/a3", a3.read())
    }
}

main {
    wifi.connect("StressNet", "password")
    mqtt.connect("mqtt://broker.local")
    run(t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, isr1, isr2, adc_poll, net_report)
}
