chip stm32f103

hardware {
    pin led: Output = PC13
}

main {
    wifi.connect("test", "pass")
}
