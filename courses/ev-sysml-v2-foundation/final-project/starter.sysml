package FinalElectricVehicleProject {
  item def ElectricalPower;
  item def TorqueCommand;
  item def CoolantFlow;

  port def PowerPort { ref item power : ElectricalPower; }
  port def CommandPort { ref item command : TorqueCommand; }
  port def ThermalPort { ref item coolant : CoolantFlow; }

  part def BatteryPack {
    port dcOut : PowerPort;
    port thermal : ThermalPort;
  }
  part def Inverter {
    port dcIn : PowerPort;
    port commandIn : CommandPort;
  }
  part def Motor { port powerIn : PowerPort; }
  part def Wheel;
  part def VehicleBody;
  part def CoolingLoop { port batterySide : ThermalPort; }
  part def VehicleController { port torqueCommand : CommandPort; }

  part def ElectricVehicle {
    part body : VehicleBody;
    // TODO 1: 补全 battery、inverter、motor、wheels[4]、cooling 和 controller 结构。
  }

  interface def BatteryToInverter {
    end source : PowerPort;
    end target : PowerPort;
    flow source.power to target.power;
  }
  interface def ControllerToInverter {
    end source : CommandPort;
    end target : CommandPort;
    flow source.command to target.command;
  }
  interface def BatteryCoolingInterface {
    end source : ThermalPort;
    end target : ThermalPort;
    flow source.coolant to target.coolant;
  }

  action def DriveCycle {
    action readDriverCommand;
    action deliverWheelTorque;
  }
  action def ChargeBattery {
    action manageCurrent;
    action stopAtTargetSoc;
  }

  state def VehicleOperatingState {
    state Parked;
    state Ready;
    state Driving;
    state Charging;
    state Fault;
  }

  requirement def RangeRequirement;
  requirement def ChargingRequirement;
  requirement def SafetyRequirement;
  requirement finalRange : RangeRequirement;
  requirement fastCharge : ChargingRequirement;
  requirement hvSafety : SafetyRequirement;

  constraint RangeBalance;
  calc def EstimateRange;
  analysis def RangeAnalysis { action estimateRange; }
  analysis finalRangeAnalysis : RangeAnalysis;

  verification def RangeRoadTest {
    // TODO 2: 添加 objective，验证 finalRange。
  }
  verification def ChargeTest {
    // TODO 3: 添加 objective，验证 fastCharge。
  }
  verification def SafetyInspection {
    // TODO 4: 添加 objective，验证 hvSafety。
  }
  verification rangeVerification : RangeRoadTest;
  verification chargeVerification : ChargeTest;
  verification safetyVerification : SafetyInspection;

  part finalVehicle : ElectricVehicle;
  action finalDriveCycle : DriveCycle;
  action finalCharge : ChargeBattery;
  state finalVehicleMode : VehicleOperatingState;

  // TODO 5: 建立 finalRange、fastCharge、hvSafety 到 finalVehicle 的 satisfy 追踪。

  view def FinalProjectEvidenceView specializes StandardViewDefinitions::GeneralView;
  view finalProjectEvidenceView : FinalProjectEvidenceView {
    expose finalVehicle;
    expose finalRange;
    expose fastCharge;
    expose hvSafety;
    expose finalRangeAnalysis;
    expose rangeVerification;
    expose chargeVerification;
    expose safetyVerification;
  }
}
