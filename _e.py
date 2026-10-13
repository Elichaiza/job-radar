def edit(path, pairs):
    raw = open(path, encoding='utf8', newline='').read()
    crlf = '\r\n' in raw
    s = raw.replace('\r\n', '\n')
    for a, b in pairs:
        assert a in s, 'missing: ' + a[:50]
        s = s.replace(a, b, 1)
    open(path, 'w', encoding='utf8', newline='').write(s.replace('\n', '\r\n') if crlf else s)

edit('docs/lib/classify.js', [
("""const CATEGORY_RULES = [
""", """const CATEGORY_RULES = [
  // Unmistakably embedded words win over "algorithm", "security" and the like.
  ['Embedded', /\b(embedded|firmware|fw|rtos|bsp|bare[- ]metal|mcu|microcontrollers?|device drivers?|bootloader|bios|uefi)\b/i],
"""),
("""  ['Embedded', /\b(embedded|firmware|fw|real[- ]?time|rt|kernel|drivers?|bsp|low[- ]level|linux)\b/i],""",
 """  ['Embedded', /\b(real[- ]?time|rt|kernel|drivers?|low[- ]level|linux|dsp|iot|robotics?|avionics|modem|phy|bluetooth|wireless|system software|systems programm\w+)\b/i],"""),
("|embedded|firmware|fpga|", "|embedded|firmware|fw|rtos|bsp|bare[- ]metal|mcu|microcontrollers?|bootloader|bios|uefi|real[- ]?time|rt|low[- ]level|drivers?|iot|robotics?|avionics|modem|bluetooth|fpga|"),
("|warehouse|driver|nurse|", "|warehouse|truck driver|delivery driver|nurse|"),
])
