import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { FanSpeed, OperationMode, VaneVerticalDirection } from "../api/const.js";
import type { AtaControlPatch, AtaUnit, Building, UnitState } from "../api/types.js";
import { parseUnitState } from "../api/types.js";
import type { MelCloudHomePlatform } from "../platform.js";
import { MANUFACTURER } from "../settings.js";
import { WriteCoalescer } from "../util/coalesce.js";
import {
  CurrentState,
  SwingMode,
  angleToVanePosition,
  TargetFanState,
  TargetState,
  fanSpeedStep,
  fanSpeedToPercent,
  fromTargetState,
  isSwinging,
  percentToFanSpeed,
  quantizeTemperature,
  temperatureRangeFor,
  temperatureStep,
  toCurrentFanState,
  toCurrentSlatState,
  toCurrentState,
  toTargetFanState,
  toTargetState,
  vanePositionToAngle,
} from "../util/mapping.js";

/**
 * One air-to-air unit, presented as a HeaterCooler plus optional extras.
 *
 * Writes are optimistic: the API answers control requests with 204 and no body,
 * so we apply the change locally, report it back to HomeKit immediately, and
 * let the next poll or WebSocket delta reconcile.
 */
export class AtaAccessory {
  readonly #heaterCooler: Service;
  readonly #fan: Service | undefined;
  readonly #vane: Service | undefined;
  readonly #temperatureSensor: Service | undefined;
  readonly #drySwitch: Service | undefined;
  readonly #fanSwitch: Service | undefined;
  readonly #autoFanSwitch: Service | undefined;
  readonly #writer: WriteCoalescer;

  #unit: AtaUnit;
  #state: UnitState;

  constructor(
    private readonly platform: MelCloudHomePlatform,
    private readonly accessory: PlatformAccessory,
    building: Building,
    unit: AtaUnit,
  ) {
    const { Service, Characteristic } = platform;
    this.#unit = unit;
    this.#state = parseUnitState(unit);

    this.#writer = new WriteCoalescer(
      platform.options.writeDebounceMs,
      (patch) => platform.client.controlAtaUnit(unit.id, patch),
      (error: unknown) => {
        this.platform.log.error(
          `Failed to control ${this.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, unit.connectedInterfaceType ?? "MELCloud Home")
      .setCharacteristic(Characteristic.SerialNumber, unit.connectedInterfaceIdentifier ?? unit.id)
      .setCharacteristic(Characteristic.Name, unit.givenDisplayName)
      .setCharacteristic(
        Characteristic.ConfiguredName,
        `${building.name} ${unit.givenDisplayName}`,
      );

    this.#heaterCooler =
      this.accessory.getService(Service.HeaterCooler) ??
      this.accessory.addService(Service.HeaterCooler, unit.givenDisplayName);
    // The unit is a thermostat first; any extra services are accessories to it.
    this.#heaterCooler.setPrimaryService(true);

    this.#fan = this.#optionalService(
      platform.options.exposeFanService,
      Service.Fanv2,
      `${unit.givenDisplayName} Fan`,
      "airflow",
    );

    this.#vane = this.#optionalService(
      platform.options.exposeVaneControl &&
        (unit.capabilities.hasAirDirection || unit.capabilities.hasSwing),
      Service.Slats,
      `${unit.givenDisplayName} Vane`,
      "vane",
    );

    this.#temperatureSensor = this.#optionalService(
      platform.options.exposeTemperatureSensors,
      Service.TemperatureSensor,
      `${unit.givenDisplayName} Temperature`,
      "temperature",
    );
    this.#drySwitch = this.#optionalService(
      platform.options.exposeDrySwitch && unit.capabilities.hasDryOperationMode,
      Service.Switch,
      `${unit.givenDisplayName} Dry`,
      "dry",
    );
    this.#fanSwitch = this.#optionalService(
      platform.options.exposeFanSwitch,
      Service.Switch,
      `${unit.givenDisplayName} Fan`,
      "fan",
    );
    this.#autoFanSwitch = this.#optionalService(
      platform.options.exposeAutoFanSwitch && unit.capabilities.hasAutomaticFanSpeed,
      Service.Switch,
      `${unit.givenDisplayName} Auto Fan`,
      "auto-fan",
    );

    this.#configureHeaterCooler();
    this.#configureFan();
    this.#configureVane();
    this.#configureExtras();
    this.#pushToHomeKit();
  }

  get name(): string {
    return this.#unit.givenDisplayName;
  }

  /** Add or remove an optional service depending on config and capabilities. */
  #optionalService(
    enabled: boolean,
    type:
      | typeof Service.Switch
      | typeof Service.TemperatureSensor
      | typeof Service.Fanv2
      | typeof Service.Slats,
    name: string,
    subtype: string,
  ): Service | undefined {
    const existing = this.accessory.getServiceById(type, subtype);
    if (!enabled) {
      // Toggling the option off should actually remove the tile, not orphan it.
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    // `addService` sets the Name characteristic, which is what these services
    // are allowed to carry. ConfiguredName is not part of Switch or
    // TemperatureSensor, and HAP only tolerates it with a warning.
    return existing ?? this.accessory.addService(type, name, subtype);
  }

  // -------------------------------------------------------------------------
  // Characteristic wiring
  // -------------------------------------------------------------------------

  #configureHeaterCooler(): void {
    const { Characteristic } = this.platform;
    const capabilities = this.#unit.capabilities;
    const service = this.#heaterCooler;

    service.setCharacteristic(Characteristic.Name, this.name);

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.#state.power ? 1 : 0))
      .onSet((value) => {
        const power = value === 1;
        this.#state = { ...this.#state, power };
        // Pair power with the mode: on a multi-split system a bare power-on can
        // be read as a mode conflict by the shared outdoor unit.
        this.#writer.submit({ power, operationMode: this.#state.operationMode ?? "Automatic" });
      });

    service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => toCurrentState(this.#state));

    // Only advertise the modes this unit actually has.
    const validStates: number[] = [
      capabilities.hasAutoOperationMode ? TargetState.AUTO : undefined,
      capabilities.hasHeatOperationMode ? TargetState.HEAT : undefined,
      capabilities.hasCoolOperationMode ? TargetState.COOL : undefined,
    ].filter((state) => state !== undefined);

    service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: validStates.length > 0 ? validStates : [TargetState.AUTO] })
      .onGet(() => toTargetState(this.#state.operationMode))
      .onSet((value) => {
        const mode = fromTargetState(Number(value));
        this.#state = { ...this.#state, operationMode: mode };
        this.#writer.submit({ operationMode: mode });
        this.#syncModeSwitches();
        this.#applyTemperatureProps(mode);
      });

    service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 60, minStep: 0.1 })
      .onGet(() => this.#state.roomTemperature ?? 0);

    // HomeKit keeps a separate setpoint per direction; the unit has one. Both
    // characteristics therefore read and write the same underlying value.
    for (const characteristic of [
      Characteristic.HeatingThresholdTemperature,
      Characteristic.CoolingThresholdTemperature,
    ]) {
      service
        .getCharacteristic(characteristic)
        .onGet(() => this.#state.setTemperature ?? 21)
        .onSet((value) => {
          const target = quantizeTemperature(
            Number(value),
            this.#state.operationMode,
            capabilities,
          );
          this.#state = { ...this.#state, setTemperature: target };
          this.#writer.submit({ setTemperature: target });
        });
    }
    this.#applyTemperatureProps(this.#state.operationMode);

    if (capabilities.numberOfFanSpeeds > 0) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: fanSpeedStep(capabilities.numberOfFanSpeeds),
        })
        .onGet(() => fanSpeedToPercent(this.#state.setFanSpeed, capabilities.numberOfFanSpeeds))
        .onSet((value) => {
          const speed = percentToFanSpeed(Number(value), capabilities.numberOfFanSpeeds);
          if (!speed) {
            return;
          }
          this.#state = { ...this.#state, setFanSpeed: speed };
          this.#writer.submit({ setFanSpeed: speed });
          this.#syncFanSpeed();
        });
    }

    if (capabilities.hasSwing || capabilities.hasAirDirection) {
      service
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => isSwinging(this.#state))
        .onSet((value) => {
          this.#setVane(value === SwingMode.ENABLED ? "Swing" : "Auto");
        });
    }

    // StatusFault and StatusActive are not part of HeaterCooler in HAP, so they
    // are reported on the temperature sensor instead, where they are valid.
  }

  /**
   * Airflow, as a Fan service.
   *
   * The Home app does not surface RotationSpeed or SwingMode on a HeaterCooler,
   * so fan speed, automatic fan speed and swing are unreachable there. Fanv2
   * gets a speed slider and an AUTO toggle, which is the only native way to
   * drive any of it. Because the HeaterCooler is the primary service, the Home
   * app folds this into the same control rather than showing it separately.
   *
   * Active mirrors unit power rather than a fan-only mode: the fan cannot run
   * with the unit off, so anything else would let the two surfaces disagree.
   */
  #configureFan(): void {
    const service = this.#fan;
    if (!service) {
      return;
    }
    const { Characteristic } = this.platform;
    const capabilities = this.#unit.capabilities;

    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => (this.#state.power ? 1 : 0))
      .onSet((value) => {
        const power = value === 1;
        this.#state = { ...this.#state, power };
        // Same pairing as the HeaterCooler: a bare power-on can read as a mode
        // conflict on a multi-split outdoor unit.
        this.#writer.submit({ power, operationMode: this.#state.operationMode ?? "Automatic" });
        this.#heaterCooler.updateCharacteristic(Characteristic.Active, power ? 1 : 0);
      });

    service
      .getCharacteristic(Characteristic.CurrentFanState)
      .onGet(() => toCurrentFanState(this.#state));

    if (capabilities.hasAutomaticFanSpeed) {
      service
        .getCharacteristic(Characteristic.TargetFanState)
        .onGet(() => toTargetFanState(this.#state.setFanSpeed))
        .onSet((value) => {
          // Leaving AUTO has to name a real speed, and the remembered one is
          // "Auto" by definition — fall back to the slowest.
          const current = this.#state.setFanSpeed;
          const next: FanSpeed =
            value === TargetFanState.AUTO
              ? "Auto"
              : current && current !== "Auto"
                ? current
                : "One";
          this.#state = { ...this.#state, setFanSpeed: next };
          this.#writer.submit({ setFanSpeed: next });
          this.#syncFanSpeed();
        });
    }

    if (capabilities.numberOfFanSpeeds > 0) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: fanSpeedStep(capabilities.numberOfFanSpeeds),
        })
        .onGet(() => fanSpeedToPercent(this.#state.setFanSpeed, capabilities.numberOfFanSpeeds))
        .onSet((value) => {
          const speed = percentToFanSpeed(Number(value), capabilities.numberOfFanSpeeds);
          if (!speed) {
            return;
          }
          this.#state = { ...this.#state, setFanSpeed: speed };
          this.#writer.submit({ setFanSpeed: speed });
          this.#syncFanSpeed();
        });
    }

    if (capabilities.hasSwing || capabilities.hasAirDirection) {
      service
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => isSwinging(this.#state))
        .onSet((value) => {
          this.#setVane(value === SwingMode.ENABLED ? "Swing" : "Auto");
        });
    }
  }

  /**
   * Vane position, as a Slats service.
   *
   * SwingMode alone can only say "swinging or not"; Slats adds a tilt angle,
   * which is the only native way to ask for a fixed vane position. Note Apple's
   * Home app has never shipped UI for this service, so it may only be reachable
   * from Eve and similar — it is inert rather than broken when unrendered.
   */
  #configureVane(): void {
    const service = this.#vane;
    if (!service) {
      return;
    }
    const { Characteristic } = this.platform;

    // The louvers themselves lie horizontally; tilting them aims the air up or
    // down, which is what the unit calls the vertical direction.
    service.setCharacteristic(Characteristic.SlatType, Characteristic.SlatType.HORIZONTAL);

    service
      .getCharacteristic(Characteristic.CurrentSlatState)
      .onGet(() => toCurrentSlatState(this.#state));

    service
      .getCharacteristic(Characteristic.SwingMode)
      .onGet(() => isSwinging(this.#state))
      .onSet((value) => {
        this.#setVane(value === SwingMode.ENABLED ? "Swing" : "Auto");
      });

    service
      .getCharacteristic(Characteristic.CurrentTiltAngle)
      .onGet(() => vanePositionToAngle(this.#state.vaneVerticalDirection) ?? 0);

    service
      .getCharacteristic(Characteristic.TargetTiltAngle)
      .setProps({ minStep: 45 })
      .onGet(() => vanePositionToAngle(this.#state.vaneVerticalDirection) ?? 0)
      .onSet((value) => {
        // Asking for an angle means asking for a fixed position, which leaves
        // Auto and Swing behind.
        this.#setVane(angleToVanePosition(Number(value)));
      });
  }

  /** Apply a vane direction and reconcile every surface that shows it. */
  #setVane(vane: VaneVerticalDirection): void {
    this.#state = { ...this.#state, vaneVerticalDirection: vane };
    this.#writer.submit({ vaneVerticalDirection: vane });
    this.#syncVane();
  }

  /** Keep swing and vane position agreeing across all three services. */
  #syncVane(): void {
    const { Characteristic } = this.platform;
    const swinging = isSwinging(this.#state);
    const angle = vanePositionToAngle(this.#state.vaneVerticalDirection);

    this.#heaterCooler.updateCharacteristic(Characteristic.SwingMode, swinging);
    this.#fan?.updateCharacteristic(Characteristic.SwingMode, swinging);
    this.#vane?.updateCharacteristic(Characteristic.SwingMode, swinging);
    this.#vane?.updateCharacteristic(
      Characteristic.CurrentSlatState,
      toCurrentSlatState(this.#state),
    );
    // Auto and Swing have no angle. Report centre for them so the stored value
    // matches what the getters return, rather than leaving HAP's -90 default.
    this.#vane?.updateCharacteristic(Characteristic.CurrentTiltAngle, angle ?? 0);
    this.#vane?.updateCharacteristic(Characteristic.TargetTiltAngle, angle ?? 0);
  }

  /** Keep every surface that shows fan speed agreeing with the current state. */
  #syncFanSpeed(): void {
    const { Characteristic } = this.platform;
    const steps = this.#unit.capabilities.numberOfFanSpeeds;
    const percent = fanSpeedToPercent(this.#state.setFanSpeed, steps);
    const auto = this.#state.setFanSpeed === "Auto";

    if (steps > 0) {
      this.#heaterCooler.updateCharacteristic(Characteristic.RotationSpeed, percent);
      this.#fan?.updateCharacteristic(Characteristic.RotationSpeed, percent);
    }
    this.#autoFanSwitch?.updateCharacteristic(Characteristic.On, auto);
    if (this.#unit.capabilities.hasAutomaticFanSpeed) {
      this.#fan?.updateCharacteristic(
        Characteristic.TargetFanState,
        toTargetFanState(this.#state.setFanSpeed),
      );
    }
  }

  /** Bound the setpoint characteristics to what the current mode allows. */
  #applyTemperatureProps(mode: OperationMode | undefined): void {
    const { Characteristic } = this.platform;
    const capabilities = this.#unit.capabilities;
    const minStep = temperatureStep(capabilities);

    // Characteristics are created carrying HAP's default value, which sits
    // outside the range these units accept. Narrowing the props without also
    // moving the value logs an "illegal value" warning on every start, so seed
    // the current setpoint (clamped) at the same time.
    const current = this.#state.setTemperature ?? 21;

    const heat = temperatureRangeFor("Heat", capabilities);
    this.#heaterCooler
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .updateValue(Math.min(Math.max(current, heat.min), heat.max))
      .setProps({ minValue: heat.min, maxValue: heat.max, minStep });

    const cool = temperatureRangeFor(mode === "Automatic" ? "Automatic" : "Cool", capabilities);
    this.#heaterCooler
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .updateValue(Math.min(Math.max(current, cool.min), cool.max))
      .setProps({ minValue: cool.min, maxValue: cool.max, minStep });
  }

  #configureExtras(): void {
    const { Characteristic } = this.platform;

    this.#temperatureSensor
      ?.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 60, minStep: 0.1 })
      .onGet(() => this.#state.roomTemperature ?? 0);
    this.#temperatureSensor
      ?.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => (this.#state.isInError ? 1 : 0));
    this.#temperatureSensor
      ?.getCharacteristic(Characteristic.StatusActive)
      .onGet(() => this.#unit.isConnected);

    this.#bindModeSwitch(this.#drySwitch, "Dry");
    this.#bindModeSwitch(this.#fanSwitch, "Fan");

    this.#autoFanSwitch
      ?.getCharacteristic(Characteristic.On)
      .onGet(() => this.#state.setFanSpeed === "Auto")
      .onSet((value) => {
        // Turning auto off has no direct API expression; drop to the lowest
        // manual speed, which is what the official app does.
        const speed = value ? "Auto" : "One";
        this.#state = { ...this.#state, setFanSpeed: speed };
        this.#writer.submit({ setFanSpeed: speed });
        this.#heaterCooler.updateCharacteristic(
          Characteristic.RotationSpeed,
          fanSpeedToPercent(speed, this.#unit.capabilities.numberOfFanSpeeds),
        );
      });
  }

  /**
   * Dry and Fan have no HomeKit counterpart, so each gets a switch. Turning one
   * on selects that mode (powering the unit on if needed); turning it off
   * returns to Cool, which is the app's own fallback.
   */
  #bindModeSwitch(service: Service | undefined, mode: OperationMode): void {
    service
      ?.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.#state.power && this.#state.operationMode === mode)
      .onSet((value: CharacteristicValue) => {
        const next: OperationMode = value ? mode : "Cool";
        this.#state = { ...this.#state, operationMode: next, power: true };
        this.#writer.submit({ power: true, operationMode: next });
        this.#syncModeSwitches();
        this.#pushToHomeKit();
      });
  }

  /** Keep the mode switches mutually exclusive without a round trip. */
  #syncModeSwitches(): void {
    const { Characteristic } = this.platform;
    const active = this.#state.power ? this.#state.operationMode : undefined;
    this.#drySwitch?.updateCharacteristic(Characteristic.On, active === "Dry");
    this.#fanSwitch?.updateCharacteristic(Characteristic.On, active === "Fan");
  }

  // -------------------------------------------------------------------------
  // Inbound updates
  // -------------------------------------------------------------------------

  /** Apply fresh server state from a poll or a real-time delta. */
  update(unit: AtaUnit): void {
    this.#unit = unit;
    this.#state = parseUnitState(unit);
    this.#pushToHomeKit();
  }

  #pushToHomeKit(): void {
    const { Characteristic } = this.platform;
    const capabilities = this.#unit.capabilities;
    const service = this.#heaterCooler;

    service.updateCharacteristic(Characteristic.Active, this.#state.power ? 1 : 0);
    service.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      toCurrentState(this.#state),
    );
    service.updateCharacteristic(
      Characteristic.TargetHeaterCoolerState,
      toTargetState(this.#state.operationMode),
    );
    this.#temperatureSensor?.updateCharacteristic(
      Characteristic.StatusFault,
      this.#state.isInError ? 1 : 0,
    );
    this.#temperatureSensor?.updateCharacteristic(
      Characteristic.StatusActive,
      this.#unit.isConnected,
    );

    if (this.#state.roomTemperature !== undefined) {
      service.updateCharacteristic(Characteristic.CurrentTemperature, this.#state.roomTemperature);
      this.#temperatureSensor?.updateCharacteristic(
        Characteristic.CurrentTemperature,
        this.#state.roomTemperature,
      );
    }
    if (this.#state.setTemperature !== undefined) {
      service.updateCharacteristic(
        Characteristic.HeatingThresholdTemperature,
        this.#state.setTemperature,
      );
      service.updateCharacteristic(
        Characteristic.CoolingThresholdTemperature,
        this.#state.setTemperature,
      );
    }
    if (capabilities.numberOfFanSpeeds > 0) {
      service.updateCharacteristic(
        Characteristic.RotationSpeed,
        fanSpeedToPercent(this.#state.setFanSpeed, capabilities.numberOfFanSpeeds),
      );
    }
    if (capabilities.hasSwing || capabilities.hasAirDirection) {
      // Covers swing on all three services plus the vane angle, so a poll or a
      // change made from the remote lands everywhere.
      this.#syncVane();
    }

    this.#fan?.updateCharacteristic(Characteristic.Active, this.#state.power ? 1 : 0);
    this.#fan?.updateCharacteristic(Characteristic.CurrentFanState, toCurrentFanState(this.#state));
    if (capabilities.hasAutomaticFanSpeed) {
      this.#fan?.updateCharacteristic(
        Characteristic.TargetFanState,
        toTargetFanState(this.#state.setFanSpeed),
      );
    }
    if (capabilities.numberOfFanSpeeds > 0) {
      this.#fan?.updateCharacteristic(
        Characteristic.RotationSpeed,
        fanSpeedToPercent(this.#state.setFanSpeed, capabilities.numberOfFanSpeeds),
      );
    }

    this.#autoFanSwitch?.updateCharacteristic(
      Characteristic.On,
      this.#state.setFanSpeed === "Auto",
    );
    this.#syncModeSwitches();

    if (this.#state.isInError && this.#state.errorCode) {
      this.platform.log.warn(`${this.name} reports error code ${this.#state.errorCode}`);
    }
  }

  dispose(): void {
    this.#writer.dispose();
  }
}

/** Re-exported for tests that build patches without a live accessory. */
export type { AtaControlPatch };
export { CurrentState, TargetState };
