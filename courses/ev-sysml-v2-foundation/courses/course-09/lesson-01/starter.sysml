package EV_C09_L01 {
  private import EV_Program_Baseline::*;
  private import EV_Requirement_Baseline::*;
  private import EV_Analysis_Baseline::*;
  private import VerificationCases::*;

  verification def RangeVerificationPlan {
    subject testVehicle : ElectricVehicle;
    attribute requiredRangeKm : ScalarValues::Real;
    attribute predictedRangeKm : ScalarValues::Real;
    // TODO 1: 添加 objective，verify vehicleRange
    // TODO 2: 添加 VerificationMethod 元数据，方法为 test 和 analyze
    return verdict : VerdictKind = VerdictKind::inconclusive;
  }

  verification rangeVerificationPlan : RangeVerificationPlan {
    subject testVehicle = evPrototype;
    // TODO 3: 添加 requiredRangeKm attribute 重定义，来源为 480.0 km 需求
    // TODO 4: 用 cityRangePrediction.predictedRangeKm 重定义 predictedRangeKm
  }

  view def VerificationCoverageView specializes StandardViewDefinitions::GeneralView;
  view verificationCoverageView : VerificationCoverageView {
    expose vehicleRange;
    expose cityRangePrediction;
    expose evPrototype;
    // TODO 5: 添加 expose rangeVerificationPlan
  }
}
