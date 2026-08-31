-- CreateTable
CREATE TABLE "_CallDefinitionOpenRoles" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CallDefinitionOpenRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CallDefinitionAnswerRoles" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CallDefinitionAnswerRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_CallDefinitionOpenRoles_B_index" ON "_CallDefinitionOpenRoles"("B");

-- CreateIndex
CREATE INDEX "_CallDefinitionAnswerRoles_B_index" ON "_CallDefinitionAnswerRoles"("B");

-- AddForeignKey
ALTER TABLE "_CallDefinitionOpenRoles" ADD CONSTRAINT "_CallDefinitionOpenRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "CallDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionOpenRoles" ADD CONSTRAINT "_CallDefinitionOpenRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "EmployeeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionAnswerRoles" ADD CONSTRAINT "_CallDefinitionAnswerRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "CallDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionAnswerRoles" ADD CONSTRAINT "_CallDefinitionAnswerRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "EmployeeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
