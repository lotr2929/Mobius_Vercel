-- Purge mobius_docs rows for files removed from Drive during cleanup
delete from mobius_docs where filename in (
  'Ong - 2012 - Ecology and the aesthetics of heat.docx',
  'Ong - 2012 - Ecology and the aesthetics of heat(2).pdf',
  'Ong - 2013 - Beyond Environmental Comfort(2).pdf',
  'Ong - 2013 - Beyond Environmental Comfort(3).pdf',
  'Ong - 2014 - Green Plot Ratio and the Role of Greenery in Low Carbon Living.docx',
  'Ong et al. - 2013 - Urban Greenery - Good for Business and Liveability.docx',
  'Ong et al. - 2017 - Green Plot Ratio and MUtopia - The integration of green infrastructure into an ecological model for cities.docx',
  'Ong et al. - Unknown - Green Plot Ratio and MUtopia - The integration of engineering services and green infrastructure in an ecological.docx',
  'Ong et al. - Unknown - Towards greater private sector uptake on urban greenery in Melbourne.docx',
  'JoBD_Light.docx',
  'JoBD_Sound.docx'
);

-- Verify what's left
select distinct filename from mobius_docs order by filename;
