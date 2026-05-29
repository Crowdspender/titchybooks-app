import Hero from "@/components/home/Hero";
import WhatItIs from "@/components/home/WhatItIs";
import TwoWorlds from "@/components/home/TwoWorlds";
import HowItWorks from "@/components/home/HowItWorks";
import ValueLoop from "@/components/home/ValueLoop";
import Examples from "@/components/home/Examples";
import FooterCTA from "@/components/home/FooterCTA";

export default function Home() {
  return (
    <div>
      <Hero />
      <WhatItIs />
      <TwoWorlds />
      <HowItWorks />
      <ValueLoop />
      <Examples />
      <FooterCTA />
    </div>
  );
}
