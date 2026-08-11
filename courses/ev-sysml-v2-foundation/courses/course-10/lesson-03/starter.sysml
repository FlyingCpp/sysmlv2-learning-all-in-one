package EV_C10_L03 {
  private import EV_C10_Baseline::*;

  part def FinalMotor :> Motor {
    port powerIn : PowerPort;
  }

  part def FinalVehicle {
    part battery : BatteryPack;
    part inverter : Inverter;
    part motor : FinalMotor;
    part wheels[4] : Wheel;
    attribute energyPer100Km : ScalarValues::Real = 16.0;
    attribute estimatedRangeKm : ScalarValues::Real = 0.0;
    attribute roadTestRangeKm : ScalarValues::Real = 488.0;

    interface batteryToInverter : PropulsionPowerInterface connect battery.dcOut to inverter.dcIn;
    interface inverterToMotor : PropulsionPowerInterface connect inverter.acOut to motor.powerIn;
  }

  requirement def FinalRangeRequirement {
    doc /* Final vehicle range shall be no less than targetRangeKm. */
    subject vehicle : FinalVehicle;
    attribute targetRangeKm : ScalarValues::Real;
    require constraint { vehicle.estimatedRangeKm >= targetRangeKm }
  }

  requirement finalRange : FinalRangeRequirement {
    subject vehicle : FinalVehicle;
    // TODO 1: 添加 targetRangeKm 的 attribute 重定义，目标值为 480.0。
  }

  constraint def RangeBalance {
    in estimatedRangeKm : ScalarValues::Real;
    in targetRangeKm : ScalarValues::Real;
    // TODO 2: 添加 estimatedRangeKm >= targetRangeKm
  }

  calc def EstimateRange {
    in batteryEnergyKWh : ScalarValues::Real;
    in energyPer100Km : ScalarValues::Real;
    // TODO 3: 添加续航计算 return。
  }

  analysis def RangeAnalysis {
    subject vehicle : FinalVehicle;
    in targetRangeKm : ScalarValues::Real;

    calc estimateRange : EstimateRange {
      in batteryEnergyKWh = vehicle.battery.usableEnergyKWh;
      in energyPer100Km = vehicle.energyPer100Km;
      // TODO 4: 返回 calc 的 rangeKm 输出。
    }

    // TODO 5: 返回 estimatedRangeKm。
    // TODO 6: 添加 assert constraint rangeCheck 绑定。
  }

  verification def RangeRoadTest {
    private import VerificationCases::*;

    doc /* Road test confirms finalRange against analysis target. */
    subject testVehicle : FinalVehicle;
    attribute requiredRangeKm : ScalarValues::Real;
    attribute predictedRangeKm : ScalarValues::Real;
    attribute measuredRangeKm : ScalarValues::Real;
    objective { verify finalRange; }
    // TODO 7: 添加基于 measuredRangeKm >= requiredRangeKm 的 VerdictKind 判定。
  }

  part finalVehicle : FinalVehicle;

  analysis finalRangeAnalysis : RangeAnalysis {
    subject vehicle = finalVehicle;
    in targetRangeKm = finalRange.targetRangeKm;
  }

  verification finalRangeVerification : RangeRoadTest {
    subject testVehicle = finalVehicle;
    // TODO 8: 添加 requiredRangeKm 的 attribute 重定义绑定。
    // TODO 9: 添加 predictedRangeKm 的 attribute 重定义绑定。
    // TODO 10: 添加 measuredRangeKm 的 attribute 重定义绑定。
  }

  // TODO 11: 添加 satisfy，说明 finalRange 由 finalVehicle 满足。

  view def FinalEvidenceView specializes StandardViewDefinitions::GeneralView;
  view finalEvidenceView : FinalEvidenceView {
    expose finalRange;
    expose finalVehicle;
    expose PropulsionPowerInterface;
    // TODO 12: 添加 finalRangeAnalysis 的 expose 视图条目。
    // TODO 13: 添加 finalRangeVerification 的 expose 视图条目。
  }
}
