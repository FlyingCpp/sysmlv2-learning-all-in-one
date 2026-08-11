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
    part battery : BatteryPack;
    part inverter : Inverter;
    part motor : Motor;
    part wheels[4] : Wheel;
    part cooling : CoolingLoop;
    part controller : VehicleController;
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
    objective { verify finalRange; }
  }
  verification def ChargeTest {
    objective { verify fastCharge; }
  }
  verification def SafetyInspection {
    objective { verify hvSafety; }
  }
  verification rangeVerification : RangeRoadTest;
  verification chargeVerification : ChargeTest;
  verification safetyVerification : SafetyInspection;

  part finalVehicle : ElectricVehicle;
  action finalDriveCycle : DriveCycle;
  action finalCharge : ChargeBattery;
  state finalVehicleMode : VehicleOperatingState;

  satisfy finalRange by finalVehicle;
  satisfy fastCharge by finalVehicle;
  satisfy hvSafety by finalVehicle;

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
