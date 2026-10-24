# Desk station setup

The desk station is a Raspberry Pi with a camera looking down at the desk and a small touchscreen. Kids tap their name, enter their PIN, and work on paper. The tutor checks each line as it's written, marks it on the screen, and speaks up when something needs another look.

**What you need**
- Raspberry Pi 4 (2 GB or more) and its official 3 A USB-C power supply
- Raspberry Pi Camera Module 2 or 3. Module 3 **Wide** is the easiest: it autofocuses and sees a whole page from cabinet height.
- A camera ribbon cable long enough to reach from the Pi to the camera (50 cm is typical; very long ones can be unreliable)
- Pimoroni HyperPixel 4.0 touchscreen (optional but recommended)
- A speaker: USB, or plugged into the Pi's headphone jack
- A microSD card (16 GB or more)

Plan on about an hour.

---

## 1. Put a fresh system on the memory card

1. On your computer, install **Raspberry Pi Imager** from raspberrypi.com/software.
2. Choose **Raspberry Pi 4**, then **Raspberry Pi OS (64-bit)**, the one *with desktop*, then your microSD card.
3. When it asks about customization, choose **Edit settings** and set:
   - Hostname: `homework-station`
   - A username and password (write them down)
   - Your Wi-Fi name and password, and your country
   - On the **Services** tab, turn on **SSH** with password sign-in
4. Write the card. This erases the old Home Assistant setup.

## 2. Connect the hardware (with the Pi unplugged)

1. **Camera:** on the Pi 4, the camera connector is the slot labeled **CAMERA**, between the HDMI and headphone ports. Lift the black clip, slide the ribbon in with the **metal contacts facing the HDMI ports**, and press the clip down. At the camera end, the contacts face the camera's circuit board.
2. **HyperPixel:** press it onto the Pi's 40-pin header so it covers the whole board. It uses every pin, so nothing else can go on the header. The camera ribbon still fits underneath or beside it.
3. **Speaker:** plug in the USB speaker, or use the headphone jack.
4. Put the microSD card in and plug in the power.

The HyperPixel stays dark until the installer turns it on in step 3. Until then, use SSH from another computer.

## 3. Install the station software

From a Mac terminal (or any computer on the same Wi-Fi), sign in to the Pi:

```bash
ssh your-username@homework-station.local   # or whatever hostname you chose
```

Then run the installer, replacing the address with your app's:

```bash
curl -fsSL https://YOUR-APP.vercel.app/pi/install | bash
```

It installs what it needs, sets the camera program to start at boot, opens the station screen full-screen when the Pi starts, turns on the HyperPixel, and restarts. It takes a few minutes.

## 4. Pair it

After the restart, the station's screen shows a code like **K7Q-4MD**. On the app's **parent page**, find **Desk stations**, enter the code, give it a name, and press **Pair**. Within a few seconds the screen switches to the clock and the kids' names.

To rename it later (the kids can help pick a name), use the pencil button next to it on the parent page.

## 5. Focus the camera

**Camera Module 3** focuses on its own; skip to step 6.

**Camera Module 2** is focused at the factory for things about a meter away, so writing 18 inches below it will be soft. Turn the lens to fix it:

1. Mount the camera where it will live, or hold it at the same height over a page of handwriting.
2. Over SSH, run:
   ```bash
   sudo systemctl stop homework-station
   python3 ~/.homework-station/station.py focus
   ```
3. On your phone or laptop, open **http://homework-station.local:8000**. You'll see the middle of the camera's view and a **sharpness** number.
4. Turn the lens counterclockwise (to focus closer) a small amount at a time, using the plastic focus tool that came with the camera or fine tweezers on the lens edge. Watch the number: higher is sharper. Stop at the highest number, when pencil looks crisp.
5. Press Ctrl+C, then `sudo systemctl start homework-station`.

## 6. Mounting under the cabinet

- **Camera:** under the cabinet, near the **front edge**, pointing straight down at where the paper goes. A small adhesive camera mount or a strip of mounting tape works. The camera can sit a little back and angle toward the paper; slight angles are fine.
- **Screen:** the Pi and HyperPixel go where she can see and tap them while writing: on a small stand at the back of the desk, or on the backsplash. The ribbon cable connects them.
- **Light:** the under-cabinet light is ideal. Avoid glare from glossy worksheets.
- **Sideways or upside down?** If photos come out rotated, edit `~/.homework-station/station.env`, set `ROTATE=90`, `180` or `270`, and run `sudo systemctl restart homework-station`.

## Using it

1. Tap your name, enter your PIN.
2. Put the paper under the camera and write each step on its own line.
3. A few seconds after each line, the screen shows the page with a **✓** beside each line that's right and a **?** on the first line to look at again. A math checker marks most lines on its own; the tutor talks only when it matters (a mistake, something the checker can't judge, or a finished problem).
4. **Check now** looks right away, **Hint** asks for a hint, **Flag** saves it to go over with a parent, **Pause** stops watching, **Done** ends.

The same conversation shows up on the Chromebook, where you can type, read longer explanations, and see the photos. If she starts on the Chromebook first, tapping her name on the station joins that conversation.

After 4 quiet minutes the station offers a hint. After 15 it stops watching. With nobody using it, the screen dims after 10 minutes. Tap it to wake it.

## Privacy and cost

- The camera sends a photo only while someone is signed in at the station and new writing appears. Otherwise everything stays on the Pi, and with nobody at the desk the station doesn't contact the app at all.
- Photos are deleted from the app after 30 days.
- Reading each photo uses a low-cost model, a fraction of a cent. The tutor looks at most every 12 seconds while writing continues, and most lines are checked by a free math checker, so an hour of homework should be well under a dollar.

## Troubleshooting

**The screen stays dark or shows the wrong orientation.**
The installer added `dtoverlay=vc4-kms-dpi-hyperpixel4` to `/boot/firmware/config.txt`. Check Pimoroni's HyperPixel 4.0 guide for your Raspberry Pi OS version. It covers turning the screen to landscape, matching the touch to the rotation, and lines to remove if the screen stays dark (some setups conflict with `dtparam=i2c_arm=on` or `dtparam=spi=on`).

**The screen is vertical (portrait).**
Over SSH, find the screen's name and try a rotation:
```bash
export WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/$(id -u)
wlr-randr                                   # the first line is the screen's name, e.g. DPI-1
wlr-randr --output DPI-1 --transform 90     # or 270 if it's upside down
```
To keep it, add the working command to the top of the desktop's startup file, then restart:
```bash
sed -i '1i wlr-randr --output DPI-1 --transform 90' ~/.config/labwc/autostart
sudo reboot
```
If taps land in the wrong place afterwards, find the touchscreen's name with `libinput list-devices` and add `<touch deviceName="THAT NAME" mapToOutput="DPI-1" />` inside `<labwc_config>` in `~/.config/labwc/rc.xml`.

**The station's screen shows a red message.**
It explains what's wrong in plain words: for example the camera software is missing, no camera was found (check the ribbon cable), or the Anthropic API key has a problem. The parent page shows the same message under Desk stations, and **Check Claude connection** on the parent page tests the API key.

**"This station isn't set up yet" or the pairing code doesn't work.**
Codes expire after 30 minutes. To get a new one:
```bash
rm ~/.homework-station/token && sudo systemctl restart homework-station
```

**Is the camera working?**
```bash
rpicam-hello --list-cameras        # should list the camera
rpicam-still -o test.jpg           # takes a photo
journalctl -u homework-station -f  # the station's log: photos sent, errors
```

**No sound.**
First tap **Test voice** under the clock on the station's screen. Over SSH, `spd-say "hello"` tests the speaker and the built-in voice without the browser. If neither makes a sound, pick the right output: right-click the speaker icon in the desktop's top bar (or use `wpctl status` and `wpctl set-default <id>` over SSH) to pick the USB speaker or headphone jack. For natural voices, choose ElevenLabs on each kid's settings page. Otherwise the station uses a robotic built-in voice.

**Updating the station software.** Run the install command again. It keeps your pairing and settings.
