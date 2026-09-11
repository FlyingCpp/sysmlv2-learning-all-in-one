package Sandbox {
  private import ScalarValues::*;

  part def Vehicle {
    part chassis : Chassis[1];
    part body : Body[1];
    part engine : Engine[1];
    part transmission : Transmission[1];
    part frontAxle : Axle[1];
    part rearAxle : Axle[1];
    part wheels : Wheel[4];
    part doors : Door[2..5];
    part seats : Seat[2..7];
    part steeringSystem : SteeringSystem[1];
    part brakeSystem : BrakeSystem[1];
  }

  part def Chassis {
    attribute material : String;
    attribute mass : Real;
  }

  part def Body {
    attribute color : String;
    attribute doorCount : Integer;
  }

  part def Engine {
    attribute power : Real;
    attribute fuelType : String;
    attribute displacement : Real;
  }

  part def Transmission {
    attribute type : String;
    attribute gearCount : Integer;
  }

  part def Axle {
    attribute loadCapacity : Real;
  }

  part def Wheel {
    attribute diameter : Real;
    attribute tireType : String;
  }

  part def Door {
    attribute powerOperated : Boolean;
  }

  part def Seat {
    attribute material : String;
    attribute adjustable : Boolean;
  }

  part def SteeringSystem {
    attribute type : String;
    attribute powerAssisted : Boolean;
  }

  part def BrakePedal {
    attribute pedalRatio : Real;
    attribute material : String;
  }

  part def BrakeBooster {
    attribute type : String;
    attribute boostRatio : Real;
  }

  part def MasterCylinder {
    attribute boreDiameter : Real;
    attribute circuitCount : Integer;
  }

  part def BrakeFluidReservoir {
    attribute capacity : Real;
    attribute fluidType : String;
  }

  part def BrakeLine {
    attribute material : String;
    attribute diameter : Real;
  }

  part def BrakeCaliper {
    attribute pistonCount : Integer;
    attribute material : String;
  }

  part def BrakeRotor {
    attribute diameter : Real;
    attribute thickness : Real;
    attribute material : String;
    attribute ventilated : Boolean;
  }

  part def BrakePad {
    attribute material : String;
    attribute thickness : Real;
  }

  part def ParkingBrake {
    attribute type : String;
  }

  part def ABSModule {
    attribute version : String;
    attribute sensorCount : Integer;
  }

  part def BrakeAssembly {
    part caliper : BrakeCaliper[1];
    part rotor : BrakeRotor[1];
    part pads : BrakePad[2];
  }

  part def BrakeSystem {
    attribute type : String;
    attribute absEquipped : Boolean;

    part pedal : BrakePedal[1];
    part booster : BrakeBooster[1];
    part masterCylinder : MasterCylinder[1];
    part fluidReservoir : BrakeFluidReservoir[1];
    part lines : BrakeLine[*];
    part frontBrakes : BrakeAssembly[2];
    part rearBrakes : BrakeAssembly[2];
    part parkingBrake : ParkingBrake[1];
    part absModule : ABSModule[0..1];
  }

  part 'vehicle' : Vehicle;

  view vehicleBrakeDetail : StandardViewDefinitions::GeneralView {
    expose Sandbox::Vehicle;
    expose Sandbox::vehicle;
    expose Sandbox::BrakeSystem;
  }
}
