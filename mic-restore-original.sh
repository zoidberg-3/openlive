#!/bin/bash
# Restore the ORIGINAL microphone gain settings (captured 2026-09-24)
amixer -c 1 sset 'Capture' 63 >/dev/null
amixer -c 1 sset 'Internal Mic Boost' 2 >/dev/null
pactl set-source-volume alsa_input.pci-0000_00_09.2.analog-stereo 84% >/dev/null
echo "mic gain restored to original (Capture 63, Boost 2, source 84%)"
