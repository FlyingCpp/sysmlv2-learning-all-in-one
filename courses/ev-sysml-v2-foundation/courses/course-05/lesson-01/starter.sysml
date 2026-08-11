package EV_C05_L01 {
  part def Driver;
  part def VehicleController;
  part def Motor;
  part def BrakeSystem;

  part def ElectricVehicle {
    part driver : Driver;
    part controller : VehicleController;
    part motor : Motor;
    part brake : BrakeSystem;
  }

  action def DriveCycle {
    // TODO 1: 添加 in 输入参数: driverAccelCmd、driverBrakeCmd、vehicleSpeedKph。
    // TODO 2: 添加 out 输出参数: motorTorqueNm、brakePressureBar。

    action readPedalSignals {
      in accelCmd : ScalarValues::Real;
      in brakeCmd : ScalarValues::Real;
      out torqueRequest : ScalarValues::Real;
      out brakeRequest : ScalarValues::Real;
    }

    action computeMotorTorque {
      in torqueRequest : ScalarValues::Real;
      in speedKph : ScalarValues::Real;
      out torqueCmd : ScalarValues::Real;
    }

    action computeBrakePressure {
      in brakeRequest : ScalarValues::Real;
      out pressureCmd : ScalarValues::Real;
    }

    // TODO 3: 添加 bind，把外层驾驶输入接入内部步骤参数。
    // TODO 4: 添加 flow，连接扭矩请求到 computeMotorTorque。
    // TODO 5: 添加 flow，连接制动请求到 computeBrakePressure。
    // TODO 6: 添加 bind，把内部计算结果接回外层输出参数。
  }

  action urbanDrive : DriveCycle;

  view def BehaviorFlowView specializes StandardViewDefinitions::ActionFlowView;
  view driveActionFlowView : BehaviorFlowView {
    expose urbanDrive;
    expose DriveCycle;
  }

  view def BehaviorReviewView specializes StandardViewDefinitions::GeneralView;
  view driveBehaviorView : BehaviorReviewView {
    expose ElectricVehicle;
    expose urbanDrive;
    // TODO 7: 添加 DriveCycle 的 expose 视图条目。
  }
}
