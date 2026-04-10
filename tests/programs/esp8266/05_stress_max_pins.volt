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

task t1() {
    every 100ms {
        p0.toggle()
    }
}
task t2() {
    every 200ms {
        p2.toggle()
    }
}
task t3() {
    every 300ms {
        p4.toggle()
    }
}
task t4() {
    every 400ms {
        p5.toggle()
    }
}
task t5() {
    every 500ms {
        p12.toggle()
    }
}
task t6() {
    every 600ms {
        p13.toggle()
    }
}
task t7() {
    every 700ms {
        p14.toggle()
    }
}
task t8() {
    every 800ms {
        p15.toggle()
    }
}
task t9() {
    every 900ms {
        p16.toggle()
    }
}

task net() {
    every 10seconds {
        mqtt.send_int("stress/alive", 1)
    }
}

main {
    wifi.connect("StressNet", "password")
    mqtt.connect("mqtt://broker.local")
    run(t1, t2, t3, t4, t5, t6, t7, t8, t9, net)
}
