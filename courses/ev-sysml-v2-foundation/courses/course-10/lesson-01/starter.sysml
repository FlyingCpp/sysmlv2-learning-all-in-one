package EV_C10_L01 {
  private import EV_C10_Baseline::*;

  part def IntegrationMotor :> Motor {
    // TODO 1: 添加 IntegrationMotor 的 port usage powerIn。
  }

  part def IntegratedVehicle {
    part battery : BatteryPack;
    part inverter : Inverter;
    part motor : IntegrationMotor;
    part wheels[4] : Wheel;
    attribute energyPer100Km : ScalarValues::Real = 16.0;
  }

  part finalVehicle : IntegratedVehicle {
    // TODO 2: 添加电池到逆变器 interface connect usage。
    // TODO 3: 添加逆变器到电机 interface connect usage。
  }

  view def IntegrationView specializes StandardViewDefinitions::InterconnectionView;
  view structureInterfaceView : IntegrationView {
    expose finalVehicle;
    // TODO 4: 添加 PropulsionPowerInterface 的 expose 视图条目。
  }
}
