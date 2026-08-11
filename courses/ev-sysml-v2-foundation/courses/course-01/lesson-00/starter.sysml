package EV_C01_L00 {
  item def ElectricalPower;
  item def TorqueCommand;
  port def PowerPort { ref item power : ElectricalPower; }
  port def CommandPort { ref item command : TorqueCommand; }

  part def BatteryPack { port dcOut : PowerPort; }
  part def Motor { port powerIn : PowerPort; }
  part def VehicleController { port commandOut : CommandPort; }
  part def Wheel;
  part def ElectricVehicle {
    part battery : BatteryPack;
    part controller : VehicleController;
    part motor : Motor;
    part wheels[4] : Wheel;
  }

  interface def PropulsionPowerInterface {
    end source : PowerPort;
    end target : PowerPort;
    flow source.power to target.power;
  }

  action def DriveCycle { action deliverTorque; }
  state def VehicleOperatingState { state Ready; state Driving; state Charging; }

  requirement def VehicleNeed;
  requirement usableRange : VehicleNeed;
  constraint RangeBalance;
  calc def EstimateRange;
  analysis def VehicleModelPurpose { action estimateRange; }
  analysis purposeCheck : VehicleModelPurpose;

  part evPreview : ElectricVehicle;
  satisfy usableRange by evPreview;

  view def CourseOverviewView specializes StandardViewDefinitions::GeneralView;
  view courseOverviewView : CourseOverviewView {
    expose ElectricVehicle;
    expose evPreview;
    expose PropulsionPowerInterface;
    expose DriveCycle;
    expose VehicleOperatingState;
    expose usableRange;
    expose purposeCheck;
  }

  view def CourseBrowserView specializes StandardViewDefinitions::BrowserView;
  view courseBrowserView : CourseBrowserView {
    expose ElectricVehicle;
    expose evPreview;
  }
}
