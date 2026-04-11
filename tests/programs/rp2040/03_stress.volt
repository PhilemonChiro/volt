chip rp2040

hardware {
    pin p0: Output = GP0
    pin p1: Output = GP1
    pin p2: Output = GP2
    pin p3: Output = GP3
    pin p4: Output = GP4
    pin p5: Output = GP5
    pin led: Output = GP25
    pin a0: Analog = GP26
    pin a1: Analog = GP27
    pin a2: Analog = GP28
}

var c0: int = 0
var c1: int = 0
var c2: int = 0
var c3: int = 0
var c4: int = 0
var c5: int = 0
var led_count: int = 0

task t0() {
    every 100ms {
        p0.toggle()
        c0 = c0 + 1
    }
}
task t1() {
    every 200ms {
        p1.toggle()
        c1 = c1 + 1
    }
}
task t2() {
    every 300ms {
        p2.toggle()
        c2 = c2 + 1
    }
}
task t3() {
    every 400ms {
        p3.toggle()
        c3 = c3 + 1
    }
}
task t4() {
    every 500ms {
        p4.toggle()
        c4 = c4 + 1
    }
}
task t5() {
    every 600ms {
        p5.toggle()
        c5 = c5 + 1
    }
}
task heartbeat() {
    every 1seconds {
        led.toggle()
        led_count = led_count + 1
    }
}
task adc_poll() {
    every 1seconds {
        let v0 = a0.read()
        let v1 = a1.read()
        let v2 = a2.read()
    }
}

main {
    run(t0, t1, t2, t3, t4, t5, heartbeat, adc_poll)
}
