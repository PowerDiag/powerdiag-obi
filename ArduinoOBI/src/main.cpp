#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include "OneWire2.h"

/** Major version number (X.x.x) */
#define ARDUINO_OBI_VERSION_MAJOR 0
/** Minor version number (x.X.x) */
#define ARDUINO_OBI_VERSION_MINOR 3
/** Patch version number (x.x.X) */
#define ARDUINO_OBI_VERSION_PATCH 0

#define ONEWIRE_PIN 6
#define ENABLE_PIN 8
/** U5, WS2812 DIN */
#define STATUS_LED_PIN 4
/** U4, BTN1 - read battery information */
#define BTN_READ_PIN 3
/** U3, BTN2 - dismiss the latched read result */
#define BTN_CLEAR_PIN 2
/** BAT_DIV, pack voltage through the R10/R11 divider */
#define VBAT_ADC_PIN A0
#define ADC_MAX_COUNTS 1023.0f
/* Internal 1.1V bandgap, selected in setup(). Not AVCC: the 5V rail is only
 * USB VBUS minus a diode drop and moves with the port, the cable and the load.
 * 1.1V across the 1:21 divider gives a 23.1V full scale. */
#define ADC_REF_VOLTS 1.1f

/** Divider ratio of R10 (200k) / R11 (10k) */
#define VBAT_DIVIDER 21.0f
/**
 * Per board trim. The bandgap reference is stable, but its absolute value is
 * only specified as 1.0V to 1.2V, so it differs from chip to chip. Set this to
 * (multimeter reading / reported reading) once, see the README.
 */
#define VBAT_CALIBRATION 1.000f
/** Below this the pack is considered absent */
/** Pack voltage mapped to the "empty" indicator colour */
/** Pack voltage mapped to the "full" indicator colour */
/** Interval between idle voltage measurements */

/** How long a failed read complains before the LED goes dark */
#define RESULT_FAIL_MS 3000

#define BTN_DEBOUNCE_MS 25
/** Both buttons act on a hold, not on a plain press */
#define BTN_HOLD_MS 1000
/** BTN2 is unlit while held, so give it a hold long enough to be deliberate */
#define BTN_CLEAR_HOLD_MS 3000
/** Global scaling of the WS2812, 0-255 */
#define STATUS_LED_BRIGHTNESS 48

/* Local button commands. These are the exact same frames the PC application
 * sends (see OpenBatteryInformation/modules/makita_lxt.py):
 *   READ_MSG_CMD    = [0x01, 0x02, 0x28, 0x33, 0xAA, 0x00]
 *   TESTMODE_CMD    = [0x01, 0x03, 0x09, 0x33, 0xD9, 0x96, 0xA5]
 *   RESET_ERROR_CMD = [0x01, 0x02, 0x09, 0x33, 0xDA, 0x04]
 * i.e. command 0x33, the payload below and the response length below. */
static byte READ_MSG_DATA[] = {0xAA, 0x00};
#define READ_MSG_RSP_LEN 0x28
static byte TESTMODE_DATA[] = {0xD9, 0x96, 0xA5};
#define TESTMODE_RSP_LEN 0x09
static byte RESET_ERROR_DATA[] = {0xDA, 0x04};
#define RESET_ERROR_RSP_LEN 0x09

/* Offsets into the response payload. The PC application indexes the framed
 * response (response[0] = cmd, response[1] = length), so payload[i] here is
 * response[i + 2] there. */
#define OFFSET_STATUS_CODE 27
#define OFFSET_LOCK 28

OneWire makita(ONEWIRE_PIN);
Adafruit_NeoPixel status_led(1, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);

#define RGB(r, g, b) (((uint32_t)(r) << 16) | ((uint32_t)(g) << 8) | (uint32_t)(b))

#define COLOR_OFF RGB(0, 0, 0)
/** BTN1 held, and talking to the battery */
#define COLOR_BUSY RGB(0, 0, 255)
/** BMS is unlocked */
#define COLOR_OK RGB(0, 255, 0)
/** BMS is locked, alternated with COLOR_OK */
#define COLOR_LOCKED RGB(255, 0, 0)
/** No usable answer from the battery */
#define COLOR_FAIL RGB(255, 0, 255)
/** Unlock done */
#define COLOR_CLEARED RGB(0, 255, 255)

enum LedMode {
	LED_SOLID,
	LED_BLINK,
	LED_BREATHE,
	/** Alternates between led_color and led_color_b */
	LED_ALTERNATE,
};

static bool led_off_at_expiry = false;
static uint32_t led_color = COLOR_OFF;
static uint32_t led_color_b = COLOR_OFF;
static uint8_t led_mode = LED_SOLID;
static uint16_t led_period = 0;
/** millis() at which the current pattern expires, 0 = stays until replaced */
static uint32_t led_expiry = 0;
static uint32_t led_written = 0xFFFFFFFF;

struct Button {
	uint8_t pin;
	bool raw;
	bool state;
	uint32_t t_raw;
	uint32_t t_pressed;
};

/** Result of the last local read, latched on the LED until it is dismissed */
enum ObiResult {
	RESULT_NONE,
	RESULT_UNLOCKED,
	RESULT_LOCKED,
	RESULT_FAIL,
};

static Button btn_read;
static Button btn_clear;
static bool read_armed = false;
static bool clear_armed = false;
static uint8_t last_result = RESULT_NONE;

void cmd_and_read_33(byte *cmd, uint8_t cmd_len, byte *rsp, uint8_t rsp_len) {
	int i;
	makita.reset();
	delayMicroseconds(400);
	makita.write(0x33,0);

	for (i=0; i < 8; i++) {
		delayMicroseconds(90);
		rsp[i] = makita.read();
	}

	for (i=0; i < cmd_len; i++) {
		delayMicroseconds(90);
		makita.write(cmd[i],0);
	}

	for (i=8; i < rsp_len + 8; i++) {
		delayMicroseconds(90);
		rsp[i] = makita.read();
	}
}

void cmd_and_read_cc(byte *cmd, uint8_t cmd_len, byte *rsp, uint8_t rsp_len) {
	int i;
	makita.reset();
	delayMicroseconds(400);
	makita.write(0xcc,0);

	for (i=0; i < cmd_len; i++) {
		delayMicroseconds(90);
		makita.write(cmd[i],0);
	}

	for (i=0; i < rsp_len; i++) {
		delayMicroseconds(90);
		rsp[i] = makita.read();
	}
}

void cmd_and_read(byte *cmd, uint8_t cmd_len, byte *rsp, uint8_t rsp_len) {
	int i;
	makita.reset();
	delayMicroseconds(400);

	for (i=0; i < cmd_len; i++) {
		delayMicroseconds(90);
		makita.write(cmd[i],0);
	}

	for (i=0; i < rsp_len; i++) {
		delayMicroseconds(90);
		rsp[i] = makita.read();
	}
}

/* --- Status LED (U5) ------------------------------------------------------ */

/**
 * Select the pattern shown on the WS2812.
 *
 * @param color     Base colour, full intensity.
 * @param mode      LED_SOLID, LED_BLINK or LED_BREATHE.
 * @param period_ms Cycle time for the blink/breathe modes.
 * @param hold_ms   Time before the pattern expires, 0 to keep it indefinitely.
 */
void led_set(uint32_t color, uint8_t mode, uint16_t period_ms, uint16_t hold_ms) {
	led_off_at_expiry = false;
	led_color = color;
	led_color_b = color;
	led_mode = mode;
	led_period = period_ms ? period_ms : 1000;
	led_expiry = hold_ms ? millis() + hold_ms : 0;
}

/**
 * A pattern that says its piece and stops. Without this an expired hold keeps
 * animating — expiry only ends led_holding(), it never touched the pixel — so
 * anything not replaced by a later led_set() blinked until the board was
 * unplugged.
 */
void led_set_transient(uint32_t color, uint8_t mode, uint16_t period_ms, uint16_t hold_ms) {
	led_set(color, mode, period_ms, hold_ms);
	led_off_at_expiry = true;
}

/** Alternate between two colours, half the period each. */
void led_set_alternate(uint32_t color_a, uint32_t color_b, uint16_t period_ms, uint16_t hold_ms) {
	led_set(color_a, LED_ALTERNATE, period_ms, hold_ms);
	led_color_b = color_b;
}

bool led_holding() {
	return led_expiry != 0 && (int32_t)(millis() - led_expiry) < 0;
}

/** Drive the WS2812 from the current pattern. Non-blocking, call often. */
void led_update() {
	uint32_t now = millis();

	if (led_off_at_expiry && !led_holding()) {
		led_set(COLOR_OFF, LED_SOLID, 0, 0);
	}

	uint32_t base = led_color;
	uint16_t level = 255;

	if (led_mode == LED_BLINK) {
		level = ((now % led_period) < (uint32_t)(led_period / 2)) ? 255 : 0;
	}
	else if (led_mode == LED_BREATHE) {
		uint16_t half = led_period / 2;
		uint16_t phase = now % led_period;
		level = (phase < half) ? (phase * 255UL / half) : ((led_period - phase) * 255UL / half);
	}
	else if (led_mode == LED_ALTERNATE) {
		base = ((now % led_period) < (uint32_t)(led_period / 2)) ? led_color : led_color_b;
	}

	uint16_t scale = level * STATUS_LED_BRIGHTNESS / 255;
	uint8_t r = (uint16_t)((base >> 16) & 0xFF) * scale / 255;
	uint8_t g = (uint16_t)((base >> 8) & 0xFF) * scale / 255;
	uint8_t b = (uint16_t)(base & 0xFF) * scale / 255;
	uint32_t out = RGB(r, g, b);

	if (out != led_written) {
		status_led.setPixelColor(0, out);
		status_led.show();
		led_written = out;
	}
}

/** Block until the current pattern expires, keeping the LED animated. */
void led_wait() {
	while (led_holding()) {
		led_update();
	}
}

/* --- Pack voltage (A0 / BAT_DIV) ------------------------------------------ */

float read_pack_voltage() {
	uint16_t acc = 0;

	for (uint8_t i = 0; i < 8; i++) {
		acc += analogRead(VBAT_ADC_PIN);
	}

	return (acc / 8.0f) * (ADC_REF_VOLTS / ADC_MAX_COUNTS) * VBAT_DIVIDER * VBAT_CALIBRATION;
}

/* --- Indication ----------------------------------------------------------- */

/**
 * Red, green, blue at power-up. It says the firmware started, and it says the
 * three channels of the WS2812 all work — a dead channel would otherwise show
 * up much later as an idle colour that reads wrong, which is a hard fault to
 * even notice, let alone diagnose.
 */
void led_selftest() {
	static const uint32_t SEQUENCE[] = { RGB(255, 0, 0), RGB(0, 255, 0), RGB(0, 0, 255) };

	for (uint8_t i = 0; i < 3; i++) {
		led_set(SEQUENCE[i], LED_SOLID, 0, 220);
		led_wait();
	}
	/* A full second dark, so the self-test reads as finished before the idle
	 * colour arrives. Any shorter and the last blue runs straight into it. */
	led_set(COLOR_OFF, LED_SOLID, 0, 1000);
	led_wait();
}

/**
 * Idle: dark. The LED says one thing now — whether the last read found the
 * pack locked — and it said two before. Green meant a full pack and it also
 * meant an unlocked one, told apart only by whether a result happened to be
 * latched, which is not something anyone can see. The voltage is on the PC to
 * three decimal places; the lock state is the only thing the board alone can
 * tell you.
 */
void show_idle() {
	led_set(COLOR_OFF, LED_SOLID, 0, 0);
}

/**
 * Show the latched result of the last read. The lock state stays up until BTN2
 * dismisses it or another read replaces it — it is the answer, and an answer
 * that erases itself is no use to someone who looked away. A failed read is
 * not an answer, so it says so for 3 s and gets out of the way.
 */
void show_result() {
	switch (last_result) {
		case RESULT_UNLOCKED:
			led_set(COLOR_OK, LED_SOLID, 0, 0);
			break;
		case RESULT_LOCKED:
			led_set_alternate(COLOR_LOCKED, COLOR_OK, 500, 0);
			break;
		case RESULT_FAIL:
			led_set_transient(COLOR_FAIL, LED_BLINK, 150, RESULT_FAIL_MS);
			break;
		default:
			show_idle();
			break;
	}
}

/* --- Buttons (U3 / U4) ---------------------------------------------------- */

void button_init(Button *b, uint8_t pin) {
	/* U3/U4 switch the pin to GND, there are no external pull-ups fitted. */
	pinMode(pin, INPUT_PULLUP);
	b->pin = pin;
	b->raw = false;
	b->state = false;
	b->t_raw = 0;
	b->t_pressed = 0;
}

/**
 * Debounce one button.
 *
 * @param pressed  Set when the button just went down.
 * @param released Set when the button just came up.
 */
void button_update(Button *b, bool *pressed, bool *released) {
	bool raw = (digitalRead(b->pin) == LOW);
	uint32_t now = millis();

	*pressed = false;
	*released = false;

	if (raw != b->raw) {
		b->raw = raw;
		b->t_raw = now;
		return;
	}

	if ((now - b->t_raw) < BTN_DEBOUNCE_MS || raw == b->state) {
		return;
	}

	b->state = raw;

	if (raw) {
		b->t_pressed = now;
		*pressed = true;
	}
	else {
		*released = true;
	}
}

/* --- Local (button driven) battery access --------------------------------- */

/* The transactions below deliberately use the same primitives, the same enable
 * line handling and the same delays as read_usb(), so a local read behaves
 * exactly like the same command coming from the PC application. */

/** BTN1 held: read the battery message and latch the lock state on the LED. */
void local_read() {
	byte payload[8 + READ_MSG_RSP_LEN];
	bool all_ff = true;
	bool all_00 = true;

	led_set(COLOR_BUSY, LED_BLINK, 160, 0);
	led_update();

	digitalWrite(ENABLE_PIN, HIGH);
	delay(400);
	cmd_and_read_33(READ_MSG_DATA, sizeof(READ_MSG_DATA), payload, READ_MSG_RSP_LEN);
	digitalWrite(ENABLE_PIN, LOW);

	for (uint8_t i = 0; i < READ_MSG_RSP_LEN; i++) {
		if (payload[i] != 0xFF) {
			all_ff = false;
		}
		if (payload[i] != 0x00) {
			all_00 = false;
		}
	}

	if (all_ff || all_00) {
		/* Same rule the PC application uses to reject a response. */
		last_result = RESULT_FAIL;
	}
	else if (payload[OFFSET_LOCK] & 0x0F) {
		last_result = RESULT_LOCKED;
	}
	else {
		last_result = RESULT_UNLOCKED;
	}

	show_result();
}

/**
 * BTN1 held while the locked pattern is shown: enter test mode, clear the
 * errors, then read the battery again so the LED shows the new state.
 */
void local_unlock() {
	byte payload[8 + TESTMODE_RSP_LEN];

	led_set(COLOR_BUSY, LED_BLINK, 80, 0);
	led_update();

	digitalWrite(ENABLE_PIN, HIGH);
	delay(400);
	cmd_and_read_33(TESTMODE_DATA, sizeof(TESTMODE_DATA), payload, TESTMODE_RSP_LEN);
	digitalWrite(ENABLE_PIN, LOW);

	digitalWrite(ENABLE_PIN, HIGH);
	delay(400);
	cmd_and_read_33(RESET_ERROR_DATA, sizeof(RESET_ERROR_DATA), payload, RESET_ERROR_RSP_LEN);
	digitalWrite(ENABLE_PIN, LOW);

	led_set_transient(COLOR_CLEARED, LED_BLINK, 120, 600);
	led_wait();

	/* Show what the battery reports now that the errors have been cleared. */
	local_read();
}

void handle_buttons() {
	bool pressed;
	bool released;

	button_update(&btn_read, &pressed, &released);
	if (pressed) {
		read_armed = true;
		led_set(COLOR_BUSY, LED_BLINK, 250, 0);
	}
	if (read_armed && btn_read.state && (millis() - btn_read.t_pressed) >= BTN_HOLD_MS) {
		read_armed = false;
		if (last_result == RESULT_LOCKED) {
			/* Acting on the locked pattern: unlock, then read back. */
			local_unlock();
		}
		else {
			local_read();
		}
	}
	if (released && read_armed) {
		/* Released too early, treat it as a cancel. */
		read_armed = false;
		show_result();
	}

	/*
	 * BTN2 dismisses the latched result after a 3 s hold. It shows nothing
	 * while held: the LED is saying whether the pack is locked, and blinking
	 * white over that answer to report a button being pressed buried the one
	 * thing it is there for. Going dark at 3 s is the confirmation.
	 */
	button_update(&btn_clear, &pressed, &released);
	if (pressed) {
		clear_armed = true;
	}
	if (clear_armed && btn_clear.state && (millis() - btn_clear.t_pressed) >= BTN_CLEAR_HOLD_MS) {
		clear_armed = false;
		last_result = RESULT_NONE;
		show_idle();
	}
	if (released) {
		clear_armed = false;
	}
}

/** Nothing to refresh: the LED holds the last result, or stays dark. */
void update_status() {
	if (last_result != RESULT_NONE || read_armed || led_holding()) {
		return;
	}

	show_idle();
}

void setup() {
	Serial.begin (9600);
    // One-wire
	pinMode(ENABLE_PIN, OUTPUT);
	//pinMode(2, OUTPUT);

	// Pack voltage is measured against the internal 1.1V bandgap, not AVCC.
	// AREF (U1 pin 18) is left unconnected on the board, so this is safe.
	analogReference(INTERNAL);
	// The conversions right after switching the reference are not valid.
	delay(10);
	analogRead(VBAT_ADC_PIN);
	analogRead(VBAT_ADC_PIN);

	// Status LED and buttons
	status_led.begin();
	status_led.clear();
	status_led.show();

	button_init(&btn_read, BTN_READ_PIN);
	button_init(&btn_clear, BTN_CLEAR_PIN);

	led_selftest();
	show_idle();
}

void send_usb(byte *rsp, byte rsp_len) {
    for (int i=0; i < rsp_len; i++) {
        Serial.write(rsp[i]);
    }
}

void read_usb() {
    if (Serial.available() >= 4) {
        byte start = Serial.read();
        byte cmd;
        byte len;
        byte data[255];
        byte rsp[255];
        byte rsp_len;

        if (start == 0x01) {
            len = Serial.read();
            rsp_len = Serial.read();
            cmd = Serial.read();
            if (len > 0){
                for (int i = 0; i < len; i++) {
                    while (Serial.available() < 1);
                    data[i] = Serial.read();
                }
            }
        }
        else {
            return;
        }
        /* Set RTS */
    	digitalWrite(ENABLE_PIN, HIGH);
	    delay(400);

        switch(cmd) {
            case 0x01:
                rsp[0] = 0x01;
                rsp[2] = ARDUINO_OBI_VERSION_MAJOR;
                rsp[3] = ARDUINO_OBI_VERSION_MINOR;
                rsp[4] = ARDUINO_OBI_VERSION_PATCH;
                break;
            case 0x02: {
                /* Pack voltage measured on BAT_DIV, in millivolts (little endian). */
                float volts = read_pack_voltage();
                uint32_t mv = (volts > 0.0f) ? (uint32_t)(volts * 1000.0f) : 0;
                if (mv > 0xFFFE) {
                    mv = 0xFFFE;
                }
                rsp[2] = mv & 0xFF;
                rsp[3] = (mv >> 8) & 0xFF;
                break;
            }
            case 0x31:
                makita.reset();
                delayMicroseconds(400);
                makita.write(0xcc,0);
                delayMicroseconds(90);
                makita.write(0x99,0);
                delay(400);
                makita.reset();
                delayMicroseconds(400);
                makita.write(0x31,0);
                delayMicroseconds(90);
                rsp[3] = makita.read();
                delayMicroseconds(90);
                rsp[2] = makita.read();
                delayMicroseconds(90);
                break;
            case 0x32:
                makita.reset();
                delayMicroseconds(400);
                makita.write(0xcc,0);
                delayMicroseconds(90);
                makita.write(0x99,0);
                delay(400);
                makita.reset();
                delayMicroseconds(400);
                makita.write(0x32,0);
                delayMicroseconds(90);
                rsp[3] = makita.read();
                delayMicroseconds(90);
                rsp[2] = makita.read();
                delayMicroseconds(90);
                break;
            case 0x33:
                cmd_and_read_33(data, len, &rsp[2], rsp_len);
                break;
            case 0xCC:
                cmd_and_read_cc(data, len, &rsp[2], rsp_len);
                break;
            default:
                rsp_len = 0;
                break;
        }
        rsp[0] = cmd;
        rsp[1] = rsp_len;
        send_usb(rsp, rsp_len + 2);

        digitalWrite(ENABLE_PIN, LOW);
    }
}

void loop() {
    read_usb();
    handle_buttons();
    update_status();
    led_update();
}
